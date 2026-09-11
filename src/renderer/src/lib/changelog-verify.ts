/** Verification guidance shown below the release notes. Kept in sync with the
 * packaging workflow: every installer is published next to a same-named
 * `.exe.sha256` file (see scripts/write-sha256.mjs). Shared by the standalone
 * changelog window (and any future viewer). */
/** Verification guidance shown below the release notes. Kept in sync with the
 * packaging workflow: every installer is published next to a same-named
 * `.exe.sha256` file (see scripts/write-sha256.mjs). */
export function verificationMarkdown(zh: boolean): string {
  return zh
    ? `### 安装校验方法

1. **可信渠道**：MPI 通过你的 Seafile 同步目录（\`我的资料库/Agent\`）或发布页分发，请勿从第三方镜像下载安装包。
2. **SHA256 校验**：每个安装包旁都有同名 \`.exe.sha256\` 文件（内含该安装包的 SHA256）。下载后在 PowerShell 中运行：

   \`Get-FileHash .\\MPI-X.Y.Z.exe -Algorithm SHA256\`

   将输出的 Hash 与 \`.sha256\` 文件内容逐字符比对，完全一致才可安装。
3. **代码签名**：MPI 为个人维护的 fork，暂未购买代码签名证书；Windows SmartScreen 提示「未知发布者」属预期现象，请通过渠道 + SHA256 双重确认后再安装。`
    : `### Verifying installers

1. **Trusted channels**: MPI is distributed via your Seafile sync folder (\`我的资料库/Agent\`) or the release page — never install from third-party mirrors.
2. **SHA256 check**: every installer ships next to a same-named \`.exe.sha256\` file containing its SHA256 hash. After downloading, run in PowerShell:

   \`Get-FileHash .\\MPI-X.Y.Z.exe -Algorithm SHA256\`

   Compare the output with the \`.sha256\` file character by character; install only when they match exactly.
3. **Code signing**: MPI is a personally maintained fork without a code-signing certificate for now; a Windows SmartScreen "unknown publisher" warning is expected. Verify via channel + SHA256 before installing.`;
}
