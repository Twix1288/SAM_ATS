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
export async function setSamScores({ applicationId, snapshot, deliveryId }) {
  const titles = Object.values(SAM_CUSTOM_FIELDS).map((f) => f.name);
  const ids = await resolveCustomFieldIds(titles);

  const values = [
    { field: SAM_CUSTOM_FIELDS.roleFit, value: Math.round(snapshot.roleFit * 100) },
    { field: SAM_CUSTOM_FIELDS.coverage, value: Math.round(snapshot.coverage * 100) },
    { field: SAM_CUSTOM_FIELDS.capability, value: snapshot.capability },
    { field: SAM_CUSTOM_FIELDS.poolRank, value: `${snapshot.pool.roleFitRank} of ${snapshot.pool.size} (top ${snapshot.pool.topPercent}%)` },
  ];

  await post(ENDPOINTS.setCustomFields, {
    objectId: applicationId,
    objectType: CUSTOM_FIELD_OBJECT.application,
    values: values.map(({ field, value }) => ({ fieldId: ids.get(field.name), fieldValue: value })),
  }, { idempotencyKey: `${deliveryId}:customFields` });

  return values.map(({ field, value }) => ({ name: field.name, value }));
}
