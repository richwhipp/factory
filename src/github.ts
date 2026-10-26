import { spawnSync } from "node:child_process";

/** A minimal GitHub REST client. Cloud sessions' GitHub proxy rejects GraphQL, so REST only. */
export class GitHub {
  constructor(
    private readonly api: string,
    private readonly token: string | undefined,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHub {
    return new GitHub(env.FACTORY_GITHUB_API ?? "https://api.github.com", resolveToken(env));
  }

  /** GET a path; resolves to null on 404, throws on any other failure. */
  async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${this.api}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} for GET ${path}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}

/** FACTORY_GITHUB_TOKEN, then GH_TOKEN, then GITHUB_TOKEN, then the gh CLI's login. */
function resolveToken(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.FACTORY_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return gh.status === 0 ? gh.stdout.trim() || undefined : undefined;
}

/** `owner/name` from a GitHub remote URL (https or ssh), or null if it isn't one. */
export function repoSlug(remoteUrl: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
