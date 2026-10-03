import { readFileSync } from 'node:fs';
import { type LoadedTemplate, loadTemplate } from '@cntxt-labs/patra-core';
import { type PatraServer, serve } from '@cntxt-labs/patra-serve';
import { templateDir } from '@cntxt-labs/patra-templates';
import { themeFile } from '@cntxt-labs/patra-themes';
import { REVIEW_TEMPLATE, reviewSession } from '@cntxt-labs/yojana';
import { type VerifierPort, type WorkLinkPort, YojanaError } from '@cntxt-labs/yojana-core';

/**
 * `yojana review --serve`: plans, live, on this machine only. yojana keeps the domain and patra
 * draws the page and takes people's actions (ADR-001): the review session projects a plan into
 * patra's review-document template and turns each intent into the engine command the CLI runs.
 * patra's server checks the token and Host, and runs one write at a time.
 */

export interface ServeOptions {
  readonly root: string;
  readonly plansDir: string | undefined;
  readonly changesDir: string | undefined;
  /** 0 picks a free port. */
  readonly port: number;
  readonly actor: string;
  readonly runCheck: boolean;
  readonly verifiers: () => VerifierPort[];
  readonly worklink: () => WorkLinkPort;
}

export interface ReviewServer {
  readonly url: string;
  readonly token: string;
  /** Every plan in the log with the URL of its page. */
  plans(): Promise<readonly { id: string; status: string; requirements: number; url: string }[]>;
  stop(): void;
}

/** patra's review-document template; a template that does not load is a broken install. */
export function reviewTemplate(): LoadedTemplate {
  const loaded = loadTemplate(templateDir(REVIEW_TEMPLATE));
  if (!loaded.ok) {
    throw new YojanaError(
      'TEMPLATE_INVALID',
      `patra's ${REVIEW_TEMPLATE} template did not load: ${loaded.problems.map((p) => `${p.file} ${p.message}`).join('; ')}`,
    );
  }
  return loaded.template;
}

export function startReviewServer(options: ServeOptions): ReviewServer {
  const session = reviewSession({
    root: options.root,
    plansDir: options.plansDir,
    changesDir: options.changesDir,
    runCheck: options.runCheck,
    verifiers: options.verifiers,
    worklink: options.worklink,
    you: options.actor,
  });
  const server: PatraServer = serve({
    templates: [reviewTemplate()],
    themeCss: readFileSync(themeFile('default'), 'utf8'),
    source: { load: (template, document) => session.load(template, document) },
    handle: (intent) => session.handle(intent),
    actor: options.actor,
    port: options.port,
  });
  return {
    url: server.url,
    token: server.token,
    plans: async () =>
      (await session.plans()).map((p) => ({ ...p, url: server.page(REVIEW_TEMPLATE, p.id) })),
    stop: () => server.stop(),
  };
}
