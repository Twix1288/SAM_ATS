/**
 * Ashby customField.setValues — writes Sam's scores onto the application.
 *
 * Uses the BATCH endpoint. Ashby documents a race condition when several single
 * setValue calls are fired concurrently at the same object, which is exactly the
 * shape of writing four fields at once.
 */
import { ENDPOINTS, SAM_CUSTOM_FIELDS, CUSTOM_FIELD_OBJECT } from '../../shared/ashby-contract.js';
import { post, resolveCustomFieldIds } from './client.js';

/**
 * Role Fit is never written without Coverage. A bare score in an ATS recreates the
 * exact problem this engine exists to prevent, one system downstream.
 */
/**
 * The values Sam writes into Ashby's own fields.
 *
 * Separated from the call so what we are willing to assert about a candidate is testable
 * without a network in reach — these four numbers are the ones a reviewer sorts and filters
 * on, and getting them wrong is the most consequential thing this integration can do.
 *
 * @param {object} snapshot
 * @returns {{field: object, value: number|string}[]}
 */
export function samFieldValues(snapshot) {
  return [
    // Role Fit is the value a reviewer sorts and filters on, so it is the one that must
    // never overstate. Below the coverage floor we write nothing into it: an empty cell
    // reads as "not scored", where a 100 from one observable anchor reads as the best
    // candidate in the pipeline. Coverage is always written — it is the number that
    // explains the empty one.
    ...(snapshot.scoreIsPublishable === false
      ? []
      : [{ field: SAM_CUSTOM_FIELDS.roleFit, value: Math.round(snapshot.roleFit * 100) }]),
    { field: SAM_CUSTOM_FIELDS.coverage, value: Math.round(snapshot.coverage * 100) },
    { field: SAM_CUSTOM_FIELDS.capability, value: snapshot.capability },
    // A sweep has no cohort. Rank is omitted rather than invented.
    ...(snapshot.pool
      ? [{ field: SAM_CUSTOM_FIELDS.poolRank, value: `${snapshot.pool.roleFitRank} of ${snapshot.pool.size} (top ${snapshot.pool.topPercent}%)` }]
      : []),
  ];
}

export async function setSamScores({ applicationId, snapshot, deliveryId }) {
  const titles = Object.values(SAM_CUSTOM_FIELDS).map((f) => f.name);
  const ids = await resolveCustomFieldIds(titles);

  const values = samFieldValues(snapshot);

  await post(ENDPOINTS.setCustomFields, {
    objectId: applicationId,
    objectType: CUSTOM_FIELD_OBJECT.application,
    values: values.map(({ field, value }) => ({ fieldId: ids.get(field.name), fieldValue: value })),
  }, { idempotencyKey: `${deliveryId}:customFields` });

  return values.map(({ field, value }) => ({ name: field.name, value }));
}
