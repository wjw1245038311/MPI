package com.mpi.app.body

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.mpi.app.body.proto.ConfirmMode
import com.mpi.app.body.proto.Msg
import com.mpi.app.body.proto.Proto
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put

/**
 * 身体层调试页（跑在 `:body` 进程，和 [MpiA11yService] 同一个进程）。
 *
 * 为什么要有它：P1 阶段还没有客户端（也没有确认卡），得有个**不依赖任何脑**的入口来验证
 * 「这台手机的这一屏，MPI 能读到什么、能不能点中」。它调用的路径与真实客户端完全一致
 * （[BodyHub.handle] → `screen.capture`），所以调试结果就是线上结果。
 *
 * adb：`adb shell am start -n com.mpi.app/.body.BodyDebugActivity`
 */
class BodyDebugActivity : Activity() {

    private lateinit var output: TextView
    private lateinit var status: TextView
    private lateinit var idInput: android.widget.EditText

    /** 上一次采集拿到的屏幕号：动作必须带它（过期就是 STALE_SCREEN）。 */
    private var lastScreen: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        BodyHub.ensure(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
            layoutParams = ViewGroup.LayoutParams(MATCH, MATCH)
        }

        status = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.GRAY)
            text = statusText()
        }
        root.addView(status)

        val row1 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row1.addView(button("读当前屏") { capture() })
        row1.addView(button("无障碍设置") {
            runCatching { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        })
        row1.addView(button("刷新状态") {
            status.text = statusText()
        })
        root.addView(row1)

        val never = CheckBox(this).apply {
            text = "免确认（调试用：写操作不再要求确认卡）"
            isChecked = (BodyHub.policyStore()?.confirmMode() ?: ConfirmMode.ASK) == ConfirmMode.NEVER
            setOnCheckedChangeListener { _, checked ->
                BodyHub.policyStore()?.setConfirmMode(if (checked) ConfirmMode.NEVER else ConfirmMode.ASK)
            }
        }
        root.addView(never)

        val remote = CheckBox(this).apply {
            text = "允许桌面驱动（默认关）"
            isChecked = BodyHub.policyStore()?.allowRemoteDriving() ?: false
            setOnCheckedChangeListener { _, checked ->
                BodyHub.policyStore()?.setAllowRemoteDriving(checked)
            }
        }
        root.addView(remote)

        // 动作验证：P1 还没有客户端，这里用最小参数发起真实的 act.tap
        val row2 = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        idInput = android.widget.EditText(this).apply {
            hint = "元素编号"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }
        row2.addView(idInput, LinearLayout.LayoutParams(0, WRAP, 1f))
        row2.addView(button("点一下") { tapById() })
        row2.addView(button("返回键") { globalKey("back") })
        root.addView(row2)

        val scroll = ScrollView(this).apply { layoutParams = LinearLayout.LayoutParams(MATCH, 0, 1f) }
        output = TextView(this).apply {
            textSize = 13f
            typeface = android.graphics.Typeface.MONOSPACE
            text = "点「读当前屏」看采集结果。"
        }
        scroll.addView(output)
        root.addView(scroll)

        setContentView(root)
    }

    private fun capture() {
        val request = Msg.req(1L, Proto.M_SCREEN_CAPTURE)
        val response = BodyHub.handle(request)
        output.text = if (response == null) {
            "身体层没初始化（无障碍服务未连接，这是正常的：先打开无障碍再回来）"
        } else {
            val ok = (response["ok"] as? JsonPrimitive)?.content == "true"
            if (ok) {
                val result = response["result"] as? JsonObject
                lastScreen = (result?.get("screen") as? JsonPrimitive)?.content
                (result?.get("text") as? JsonPrimitive)?.content ?: response.toString()
            } else {
                failureText(response)
            }
        }
        status.text = statusText()
    }

    /** 走真实的 `act.tap` 路径：先拿写入锁，再点，最后放锁。 */
    private fun tapById() {
        val screen = lastScreen
        if (screen == null) {
            output.text = "先点「读当前屏」，编号才有意义"
            return
        }
        val id = idInput.text.toString().toIntOrNull()
        if (id == null) {
            output.text = "上面填一个编号（屏文本里的 [n]）"
            return
        }
        val begin = BodyHub.handle(Msg.req(2L, Proto.M_TASK_BEGIN)) ?: return
        val taskId = ((begin["result"] as? JsonObject)?.get("taskId") as? JsonPrimitive)?.content
        if (taskId == null) {
            output.text = "拿不到写入锁：${failureText(begin)}"
            return
        }
        try {
            val params = kotlinx.serialization.json.buildJsonObject {
                put("screen", screen)
                put("id", id)
            }
            val tap = BodyHub.handle(Msg.req(3L, Proto.M_ACT_TAP, params))
            output.text = tap?.let { resp ->
                val ok = (resp["ok"] as? JsonPrimitive)?.content == "true"
                if (ok) {
                    val result = resp["result"] as? JsonObject
                    lastScreen = (result?.get("screen") as? JsonPrimitive)?.content
                    "点成功 → 新屏 ${lastScreen}\n\n${(result?.get("text") as? JsonPrimitive)?.content.orEmpty()}"
                } else {
                    failureText(resp)
                }
            } ?: "身体层没初始化"
        } finally {
            BodyHub.handle(
                Msg.req(
                    4L,
                    Proto.M_TASK_END,
                    kotlinx.serialization.json.buildJsonObject { put("taskId", taskId) },
                ),
            )
        }
    }

    /** 系统键（back/home/recents/notifications），同样需要写入锁。 */
    private fun globalKey(key: String) {
        val begin = BodyHub.handle(Msg.req(5L, Proto.M_TASK_BEGIN)) ?: return
        val taskId = ((begin["result"] as? JsonObject)?.get("taskId") as? JsonPrimitive)?.content ?: return
        try {
            val params = kotlinx.serialization.json.buildJsonObject { put("key", key) }
            val resp = BodyHub.handle(Msg.req(6L, Proto.M_ACT_KEY, params))
            output.text = resp?.let { r ->
                val ok = (r["ok"] as? JsonPrimitive)?.content == "true"
                if (ok) "已按 $key" else failureText(r)
            } ?: "身体层没初始化"
        } finally {
            BodyHub.handle(
                Msg.req(
                    7L,
                    Proto.M_TASK_END,
                    kotlinx.serialization.json.buildJsonObject { put("taskId", taskId) },
                ),
            )
        }
    }

    private fun failureText(response: JsonObject): String =
        "失败：${(response["code"] as? JsonPrimitive)?.content} " +
            "${(response["message"] as? JsonPrimitive)?.content}"

    private fun statusText(): String {
        val enabled = MpiA11yService.isEnabled(this)
        val connected = BodyHub.connected
        val mode = BodyHub.policyStore()?.confirmMode()?.name ?: ConfirmMode.ASK.name
        return "无障碍已授权=$enabled · 服务已连接=$connected · 确认模式=$mode"
    }

    private fun button(label: String, onClick: () -> Unit): Button = Button(this).apply {
        text = label
        layoutParams = LinearLayout.LayoutParams(0, WRAP, 1f).apply { marginEnd = dp(6) }
        setOnClickListener { onClick() }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}
