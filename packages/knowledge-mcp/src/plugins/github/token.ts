/**
 * GitHub token for repo_tree and the remote GitHub MCP. GITHUB_PAT wins: shells, CI and Codespaces often
 * export a broad GITHUB_TOKEN, and every user of this server would inherit its access.
 */
export const githubToken = (): string | undefined => process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
