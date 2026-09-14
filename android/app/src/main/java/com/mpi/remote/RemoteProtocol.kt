package com.mpi.remote

/**
 * Wire-contract mirror of `protocol/remote-v1.schema.json` / `mobile/shared/protocol.ts`.
 *
 * The phone client is the H5 bundle running in this shell's WebView, so these are
 * NOT used to (de)serialize traffic today — they exist so the Kotlin side has a
 * typed, reviewed view of what crosses the relay boundary, and so a native
 * feature added later cannot silently invent field names.
 *
 * Rules that matter when extending this file (see docs/MOBILE-DESIGN.md §4.4):
 *  - no credentials, host paths or host configuration may appear here;
 *  - `provider` is a display key only — never a token.
 */
data class RemoteEnvelope<T>(
    val v: Int = 1,
    val type: String,
    val sessionId: String,
    val sentAt: Long,
    val requestId: String? = null,
    val threadId: String? = null,
    val ok: Boolean? = null,
    val error: String? = null,
    val payload: T? = null,
)

data class RemoteProject(
    val id: String,
    val name: String,
    val threadCount: Int,
    val updatedAt: Long,
)

data class RemoteThreadSummary(
    val id: String,
    val projectId: String,
    val title: String,
    val preview: String,
    val updatedAt: Long,
    val messageCount: Int,
    val state: String,
    val permission: String,
)

data class RemoteMessage(
    val role: String,
    val text: String,
    val seq: Int,
)

/** A model option intentionally contains only display metadata. */
data class RemoteModelOption(
    val provider: String,
    val id: String,
    val name: String? = null,
    val reasoning: Boolean? = null,
)

/** A host-installed skill exposed as a safe slash invocation (host path omitted). */
data class RemoteSkill(
    val name: String,
    val command: String,
    val description: String? = null,
)

data class RemoteFileArtifact(
    val name: String,
    val path: String,
    val ext: String,
    val action: String,
)

data class RemoteThreadSnapshot(
    val id: String,
    val projectId: String,
    val title: String,
    val preview: String,
    val updatedAt: Long,
    val messageCount: Int,
    val state: String,
    val permission: String,
    val cwdName: String,
    val model: RemoteModelRef? = null,
    val availableModels: List<RemoteModelOption> = emptyList(),
    val skills: List<RemoteSkill> = emptyList(),
    val thinkingLevel: String,
    val messages: List<RemoteMessage> = emptyList(),
    val nextSeq: Int,
)

data class RemoteModelRef(val provider: String, val id: String)
