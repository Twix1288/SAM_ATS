/**
 * The only surface in Ashby where Sam's numbers become a sortable, filterable LIST.
 *
 * THE PROBLEM THIS SOLVES. Custom fields are visible on a candidate and useless for finding
 * one: verified against a live org, every list endpoint ignores a custom-field filter and
 * still answers `success: true`. A recruiter cannot ask "show me everyone Sam rated above
 * 70" through the API, and the pipeline view has no column control.
 *
 * Projects are the exception. Ashby documents custom-field COLUMNS for projects — it is the
 * one place a `Sam Role Fit` value can be shown in a column and sorted on. Dropping every
 * graded candidate into one turns four invisible numbers into a ranked shortlist.
 *
 * WHY IT IS OPT-IN, AND SILENT WHEN ABSENT. `project.create` returns
 * **403 missing_endpoint_permission** — the integration cannot make the project, and should
 * not hold a credential that could. So a human creates one, once, named anything containing
 * "Sam". If they never do, this does nothing and costs one list call. Nobody is blocked, and
 * no client is forced into a workflow they did not ask for.
 */
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { post } from './client.js';

/** Matched loosely on purpose: the client names their own project. */
export const SAM_PROJECT_HINT = /sam/i;

let cached; // undefined = not looked up yet, null = looked and there is none

export async function resolveSamProjectId() {
  if (cached !== undefined) return cached;
  try {
    const projects = (await post(ENDPOINTS.listProjects, { limit: 100 })) ?? [];
    const found = projects.find((p) => !p.isArchived && SAM_PROJECT_HINT.test(p.title ?? ''));
    cached = found?.id ?? null;
  } catch {
    cached = null;                      // a failed lookup must not fail a delivery
  }
  return cached;
}

/**
 * Adds a graded candidate to the Sam project, if the client made one.
 *
 * Never throws, and reports "no project" as an ordinary outcome rather than an error — the
 * common case is a client who has not created one, and that is a choice, not a fault.
 */
export async function addToSamProject({ candidateId }) {
  const projectId = await resolveSamProjectId();
  if (!projectId) return { ok: false, skipped: true, detail: 'no Sam project in this org' };
  try {
    await post(ENDPOINTS.addCandidateProject, { candidateId, projectId });
    return { ok: true, projectId };
  } catch (err) {
    return { ok: false, skipped: false, detail: err.message };
  }
}

/** Only for tests. */
export const resetProjectCache = () => { cached = undefined; };
