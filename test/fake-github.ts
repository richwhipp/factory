import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRepo = {
  default_branch: string;
  has_issues: boolean;
  labels: string[];
  /** Branch protection per branch, as GitHub's REST API returns it; absent = not protected. */
  protection: Record<string, unknown>;
  checkRuns: Record<string, { name: string; status: string; conclusion: string | null }[]>;
  statuses: Record<string, { state: string; total_count: number }>;
};

export type Call = { method: string; path: string; body?: unknown };

type Handler = (repo: FakeRepo, match: RegExpExecArray, body: unknown) => [number, unknown];

/**
 * An in-memory stand-in for GitHub's REST API, served over HTTP so the CLI under test talks
 * to it exactly as it would to GitHub (point FACTORY_GITHUB_API at `url`). Every call is
 * recorded in `calls`. Add routes as later commands need them.
 */
export class FakeGitHub {
  readonly repos = new Map<string, FakeRepo>();
  readonly calls: Call[] = [];
  url = "";
  private server: Server | null = null;

  private readonly routes: [string, RegExp, Handler][] = [
    ["GET", /^$/, (r) => [200, { default_branch: r.default_branch, has_issues: r.has_issues }]],
    ["GET", /^\/labels$/, (r) => [200, r.labels.map((name) => ({ name }))]],
    [
      "GET",
      /^\/branches\/([^/]+)\/protection$/,
      (r, m) => {
        const p = r.protection[m[1] as string];
        return p ? [200, p] : [404, { message: "Branch not protected" }];
      },
    ],
    [
      "GET",
      /^\/commits\/([^/]+)\/check-runs$/,
      (r, m) => {
        const runs = r.checkRuns[m[1] as string] ?? [];
        return [200, { total_count: runs.length, check_runs: runs }];
      },
    ],
    [
      "GET",
      /^\/commits\/([^/]+)\/status$/,
      (r, m) => [200, r.statuses[m[1] as string] ?? { state: "pending", total_count: 0 }],
    ],
  ];

  /** Adds a repository that meets every GitHub-side rule of the Repo contract. */
  addCompliantRepo(slug: string, overrides: Partial<FakeRepo> = {}): FakeRepo {
    const repo: FakeRepo = {
      default_branch: "main",
      has_issues: true,
      labels: [
        "factory:run",
        "factory:ticket",
        "factory:building",
        "factory:needs-operator",
        "factory:limited",
        "factory:paused",
      ],
      protection: {
        main: {
          required_pull_request_reviews: { required_approving_review_count: 0 },
          required_status_checks: { strict: false, contexts: ["verify"] },
          allow_force_pushes: { enabled: false },
        },
      },
      checkRuns: { main: [{ name: "verify", status: "completed", conclusion: "success" }] },
      statuses: {},
      ...overrides,
    };
    this.repos.set(slug, repo);
    return repo;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = (req.url ?? "").split("?")[0] as string;
    const method = req.method ?? "GET";
    this.calls.push({ method, path, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const m = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(path);
    const repo = m ? this.repos.get(m[1] as string) : undefined;
    if (!m || !repo) return send(404, { message: "Not Found" });
    for (const [verb, pattern, handler] of this.routes) {
      const match = pattern.exec(m[2] as string);
      if (verb === method && match) return send(...handler(repo, match, body));
    }
    send(404, { message: "Not Found" });
  }
}
