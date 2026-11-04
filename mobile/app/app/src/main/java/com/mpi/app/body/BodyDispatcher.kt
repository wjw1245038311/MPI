package com.mpi.app.body

import com.mpi.app.body.proto.Box
import com.mpi.app.body.proto.ElementKind
import com.mpi.app.body.proto.Msg
import com.mpi.app.body.proto.PolicyOp
import com.mpi.app.body.proto.PolicyTarget
import com.mpi.app.body.proto.Proto
import com.mpi.app.body.proto.SafetyGate
import com.mpi.app.body.proto.ScreenElement
import com.mpi.app.body.proto.ScreenInput
import com.mpi.app.body.proto.ScreenText
import com.mpi.app.body.proto.Verdict
import com.mpi.app.body.proto.WindowKind
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 带错误码的失败（会被翻译成 `res{ok:false}`）。 */
internal class BodyError(val code: String, message: String) : Exception(message)

/**
 * 方法表实现（设计文档 §3.2）。
 *
 * 三条不变量：
 *  - 任何动作都必须带**当前** `screen` 号，否则 `STALE_SCREEN`；
 *  - 写操作必须先 `task.begin` 拿到写入锁（同一时刻只有一个写入者）；
 *  - 安全闸说不做就不做——`Ask` 在确认卡做出来之前一律按「需要确认」失败（fail-closed）。
 */
internal class BodyDispatcher(
    private val device: () -> BodyDevice?,
    private val policyStore: BodyPolicyStore,
    private val emit: (JsonObject) -> Unit,
) {

    private var screenCounter = 0
    private var currentScreen: String? = null
    private val elements = HashMap<Int, ScreenElement>()
    private val priorKeys = HashMap<String, Set<String>>()

    /** 写入锁：持有者是 `taskId`。 */
    private var writerTask: String? = null

    fun handle(req: JsonObject): JsonObject {
        val id = Msg.idOf(req) ?: 0L
        val method = Msg.methodOf(req).orEmpty()
        val params = Msg.paramsOf(req)
        return try {
            Msg.ok(id, dispatch(method, params))
        } catch (e: BodyError) {
            Msg.err(id, e.code, e.message ?: "")
        } catch (e: Exception) {
            Msg.err(id, Proto.ERR_BAD_REQUEST, "${e.javaClass.simpleName}：${e.message ?: ""}")
        }
    }

    /** 熄屏 / 无障碍断开 / 用户停止：释放写入锁并广播 `task.stop`。 */
    fun stop(reason: String) {
        writerTask = null
        emit(Msg.evt(Proto.E_TASK_STOP, buildJsonObject { put("reason", reason) }))
    }

    fun isWriterTask(taskId: String?): Boolean = taskId != null && writerTask == taskId

    // ---- 方法分派 ----

    private fun dispatch(method: String, params: JsonObject): JsonObject = when (method) {
        Proto.M_SCREEN_CAPTURE -> screenResult(capture(Msg.bool(params, "detail") ?: false))
        Proto.M_ACT_TAP -> tap(params)
        Proto.M_ACT_TYPE -> type(params)
        Proto.M_ACT_SCROLL -> scroll(params)
        Proto.M_ACT_KEY -> key(params)
        Proto.M_ACT_TAP_XY -> throw BodyError(Proto.ERR_NEEDS_CONFIRM, "坐标点击每步都要确认（确认卡未实现）")
        Proto.M_TASK_BEGIN -> taskBegin()
        Proto.M_TASK_END -> taskEnd(params)
        else -> throw BodyError(Proto.ERR_BAD_REQUEST, "未知方法：$method")
    }

    // ---- 采集 ----

    private fun capture(detail: Boolean): ScreenSnapshot {
        val dev = device() ?: throw BodyError(Proto.ERR_NOT_ENABLED, "无障碍服务没连上，请先在系统设置里打开")
        val roots = dev.roots()
        if (roots.isEmpty()) throw BodyError(Proto.ERR_NO_SCREEN, "读不到当前屏幕（可能是安全窗口或熄屏）")
        val screen = Box(0, 0, dev.screenWidth, dev.screenHeight)
        val windows = TreeCapture.capture(roots, screen, dev.keyboardShown())
        val pkg = dev.foregroundPackage() ?: windows.lastOrNull()?.packageName
        val id = "s${++screenCounter}"
        val formatted = ScreenText.format(
            ScreenInput(
                screenId = id,
                appLabel = dev.appLabel(pkg),
                packageName = pkg,
                width = dev.screenWidth,
                height = dev.screenHeight,
                keyboardShown = dev.keyboardShown(),
                windows = windows,
                detail = detail,
                previousKeys = pkg?.let { priorKeys[it] },
            ),
        )
        currentScreen = id
        elements.clear()
        formatted.elements.forEach { elements[it.id] = it }
        if (pkg != null) priorKeys[pkg] = formatted.keys
        return ScreenSnapshot(id, formatted, pkg, dev.appLabel(pkg))
    }

    private fun screenResult(snap: ScreenSnapshot): JsonObject = buildJsonObject {
        put("screen", snap.screenId)
        put("app", snap.appLabel ?: "")
        put("package", snap.packageName ?: "")
        put("text", snap.formatted.text)
        put("hidden", snap.formatted.hidden)
        put("poor", snap.formatted.poorTree)
        put("elements", snap.formatted.elements.size)
    }

    // ---- 动作 ----

    private fun tap(params: JsonObject): JsonObject {
        requireWriter()
        val dev = requireDevice()
        val el = element(params)
        gate(PolicyOp.TAP, el, dev)
        val node = findNode(dev, el)
        val actuator = dev.actuator() ?: throw BodyError(Proto.ERR_NOT_ENABLED, "无障碍服务没连上")
        val outcome = actuator.click(node, el.bounds, screenBox(dev), Msg.bool(params, "long") ?: false)
        if (!outcome.accepted) throw BodyError(Proto.ERR_STALE_SCREEN, "点不动（元素可能已经失效），请重新读屏")
        emit(
            Msg.evt(
                Proto.E_PROGRESS,
                buildJsonObject {
                    put("step", "tap")
                    put("note", "点「${el.label.take(20)}」")
                },
            ),
        )
        return screenResult(capture(false))
    }

    private fun type(params: JsonObject): JsonObject {
        requireWriter()
        val dev = requireDevice()
        val el = element(params)
        val text = Msg.str(params, "text") ?: throw BodyError(Proto.ERR_BAD_REQUEST, "缺少 text")
        gate(PolicyOp.TYPE, el, dev)
        if (!el.editable) throw BodyError(Proto.ERR_BAD_REQUEST, "[${el.id}] 不是输入框")
        val node = findNode(dev, el) ?: throw BodyError(Proto.ERR_STALE_SCREEN, "输入框已失效，请重新读屏")
        val actuator = dev.actuator() ?: throw BodyError(Proto.ERR_NOT_ENABLED, "无障碍服务没连上")
        if (!actuator.setText(node, text)) throw BodyError(Proto.ERR_NO_SCREEN, "写不进这个输入框")
        if (Msg.bool(params, "submit") == true) actuator.imeEnter(node)
        // 回读：刷新后取节点 text（写不进去时这里能看出来）
        runCatching { node.refresh() }
        val readback = runCatching { node.text?.toString() }.getOrNull().orEmpty()
        return buildJsonObject {
            put("screen", currentScreen ?: "")
            put("readback", readback)
        }
    }

    private fun scroll(params: JsonObject): JsonObject {
        requireWriter()
        val dev = requireDevice()
        val direction = Msg.str(params, "direction") ?: throw BodyError(Proto.ERR_BAD_REQUEST, "缺少 direction")
        if (direction !in listOf("up", "down", "left", "right")) {
            throw BodyError(Proto.ERR_BAD_REQUEST, "direction 只能是 up/down/left/right")
        }
        val el = if (Msg.int(params, "id") != null) element(params) else null
        val node = el?.let { findNode(dev, it) } ?: dev.roots().lastOrNull()
        val actuator = dev.actuator() ?: throw BodyError(Proto.ERR_NOT_ENABLED, "无障碍服务没连上")
        val bounds = el?.bounds ?: screenBox(dev)
        val outcome = actuator.scroll(node, el?.scroll ?: 0, el?.horizontal ?: false, direction, bounds, screenBox(dev))
        if (!outcome.accepted) throw BodyError(Proto.ERR_STALE_SCREEN, "滚不动，请重新读屏")
        return screenResult(capture(false))
    }

    private fun key(params: JsonObject): JsonObject {
        requireWriter()
        val dev = requireDevice()
        val key = Msg.str(params, "key") ?: throw BodyError(Proto.ERR_BAD_REQUEST, "缺少 key")
        val actuator = dev.actuator() ?: throw BodyError(Proto.ERR_NOT_ENABLED, "无障碍服务没连上")
        if (!actuator.global(key)) throw BodyError(Proto.ERR_BAD_REQUEST, "不支持的按键：$key")
        return screenResult(capture(false))
    }

    // ---- 任务（写入锁）----

    private fun taskBegin(): JsonObject {
        if (writerTask != null) throw BodyError(Proto.ERR_BUSY, "已有任务在操作手机")
        val taskId = UUID.randomUUID().toString()
        writerTask = taskId
        return buildJsonObject { put("taskId", taskId) }
    }

    private fun taskEnd(params: JsonObject): JsonObject {
        val taskId = Msg.str(params, "taskId") ?: throw BodyError(Proto.ERR_BAD_REQUEST, "缺少 taskId")
        if (writerTask != taskId) throw BodyError(Proto.ERR_BUSY, "没有这个任务的写入锁")
        writerTask = null
        return buildJsonObject { put("ok", true) }
    }

    // ---- 小工具 ----

    private fun requireDevice(): BodyDevice =
        device() ?: throw BodyError(Proto.ERR_NOT_ENABLED, "无障碍服务没连上，请先在系统设置里打开")

    private fun requireWriter() {
        if (writerTask == null) throw BodyError(Proto.ERR_BUSY, "写操作前先 task.begin")
    }

    private fun screenBox(dev: BodyDevice) = Box(0, 0, dev.screenWidth, dev.screenHeight)

    private fun element(params: JsonObject): ScreenElement {
        val screen = Msg.str(params, "screen") ?: throw BodyError(Proto.ERR_BAD_REQUEST, "缺少 screen")
        if (screen != currentScreen) {
            throw BodyError(Proto.ERR_STALE_SCREEN, "屏幕号已过期（当前 ${currentScreen ?: "无"}），请重新读屏")
        }
        val id = Msg.int(params, "id") ?: throw BodyError(Proto.ERR_BAD_REQUEST, "缺少 id")
        val el = elements[id] ?: throw BodyError(Proto.ERR_STALE_SCREEN, "屏上没有 [$id]，请重新读屏")
        if (!ScreenText.matches(el, Msg.str(params, "fingerprint"))) {
            throw BodyError(Proto.ERR_STALE_SCREEN, "元素位置/文字变了，请重新读屏")
        }
        return el
    }

    private fun findNode(dev: BodyDevice, el: ScreenElement) =
        TreeCapture.findByBounds(dev.roots(), el.bounds, el.label)

    private fun gate(op: PolicyOp, el: ScreenElement, dev: BodyDevice) {
        val pkg = el.packageName ?: dev.foregroundPackage()
        val target = PolicyTarget(
            packageName = pkg,
            windowKind = TreeCapture.kindOf(pkg),
            label = el.label,
            password = el.password,
            sensitiveWord = el.sensitiveWord,
        )
        when (val verdict = SafetyGate.decide(op, target, policyStore.policy(), dev.ownPackage)) {
            // 硬拒绝：换条路（handoff），不重试
            is Verdict.Deny -> throw BodyError(Proto.ERR_DENIED, verdict.reason)
            // 要确认但确认卡还没做：fail-closed
            is Verdict.Ask -> throw BodyError(Proto.ERR_NEEDS_CONFIRM, "${verdict.reason}（确认卡未实现）")
            Verdict.Allow -> Unit
        }
    }
}

/** 元素种类在 UI 上只用得到这三类；这里保留给以后的操作记录。 */
internal val ScreenElement.kindLabel: String
    get() = when (kind) {
        ElementKind.INPUT -> "输入框"
        ElementKind.LIST -> "列表"
        ElementKind.ITEM -> role
    }

internal fun WindowKind.isSystem(): Boolean = this == WindowKind.SYSTEM
