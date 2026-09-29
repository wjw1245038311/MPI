package com.mpi.app.data

import android.content.Context
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.database.StandaloneDatabaseProvider
import java.io.File

/**
 * 视频**播放缓存**（ExoPlayer 的 SimpleCache）——「看过一次就不该再下第二次」。
 *
 * 为什么需要它：附件直连把读 URL 直接交给 ExoPlayer 流式播（Range），播完字节就没了；
 * 第二次点开同一个视频又要从头下（弱网/走中继时这一点特别刺眼）。把 ExoPlayer 的
 * 上游包一层磁盘缓存后，第一次边播边存，之后**从本地读**——首帧瞬间出来，也能拖动。
 *
 * **缓存 key 必须是附件名，不能是 URL**：直连 URL 每次申请都是新 token
 * （`/att/<24 字节随机>`），拿 URL 当 key 等于每次都是冷启动。本地文件源仍用 URI 当 key。
 *
 * 为什么放 cacheDir 并用 LRU：[缓存]系统可以随时清理，且不会让自用手机的存储无限涨。
 * 与中继分片那条路写下的 `cacheDir/video-attachments/<名字>` 是两套机制（那份是整文件、
 * 给「拉完才播」用），互不冲突。
 */
object VideoMediaCache {
    /** 上限：够存几个大视频，又不至于吃掉手机存储（临时文件，系统可回收）。 */
    const val MAX_BYTES = 512L * 1024 * 1024

    @Volatile
    private var instance: SimpleCache? = null

    /** 进程内单例：同一个目录只能有一个 SimpleCache 实例（否则会互相锁冲突）。 */
    fun get(context: Context): SimpleCache = instance ?: synchronized(this) {
        instance ?: SimpleCache(
            File(context.applicationContext.cacheDir, "video-stream-cache"),
            LeastRecentlyUsedCacheEvictor(MAX_BYTES),
            StandaloneDatabaseProvider(context.applicationContext),
        ).also { instance = it }
    }

    /**
     * 数据源工厂：缓存命中就直接读盘，未命中走 [upstream]（直连 URL 或本地文件）并写缓存。
     *
     * `FLAG_IGNORE_CACHE_ON_ERROR`：上游失败（令牌过期、主机离线）时不要卡在缓存上，
     * 直接报错让上层回落——否则用户看到的是一片死等。
     */
    fun dataSourceFactory(
        context: Context,
        keyOf: (androidx.media3.datasource.DataSpec) -> String,
        upstream: androidx.media3.datasource.DataSource.Factory,
    ): CacheDataSource.Factory = CacheDataSource.Factory()
        .setCache(get(context))
        .setUpstreamDataSourceFactory(upstream)
        .setCacheKeyFactory { spec -> keyOf(spec) }
        .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    /** 远端附件的稳定 key（与 URL 无关）。 */
    fun keyForAttachment(name: String): String = "attachment:$name"
}
