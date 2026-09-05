import type { APIRoute } from 'astro';
import { verifyJobAccess } from '../../lib/job-access';
import { getJob } from '../../lib/job-store';
import { calculateMilestoneProgress } from '../../lib/purchase-milestone';
import type { PublicMilestoneReadModel } from '../../lib/purchase-milestone';
import {
  getSgxMilestoneReadModel,
  getSgxOrderByJobId,
  getSgxPassById,
  getSgxPurchaseHistoryByPassId,
} from '../../lib/sgx-pass';

export const prerender = false;

const privateNoStoreHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
};

const GENERIC_GENERATION_ERROR = 'No pudimos generar tu imagen.';
const MODERATION_GENERATION_ERROR = 'No pudimos procesar una de las imágenes enviadas. No se realizó un nuevo cobro.';

export const GET: APIRoute = async ({ url }) => {
  const jobId = url.searchParams.get('jobId')?.trim() || '';
  const accessToken = url.searchParams.get('token');
  const unavailable = () => new Response(JSON.stringify({ error: 'Resultado no disponible' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...privateNoStoreHeaders },
  });

  if (!jobId || !accessToken) {
    return unavailable();
  }

  let job;
  try {
    job = await getJob(jobId);
  } catch {
    return unavailable();
  }

  if (!job || !verifyJobAccess(job, accessToken)) {
    return unavailable();
  }

  let sgxPass: { code: string; status: 'active' | 'suspended' | 'revoked' } | null = null;
  let purchaseNumber: string | null = null;
  let purchaseHistory: Array<{ purchase_number: string; is_current: boolean }> = [];
  let milestoneReadModel: PublicMilestoneReadModel = {
    next_milestone: null,
    current_milestone: null,
  };
  let milestoneProgress: { percentage: number; remaining: string; reached: boolean } | null = null;
  if (job.status === 'completed') {
    if (job.sgxPassId) {
      try {
        const pass = await getSgxPassById(job.sgxPassId);
        if (pass) {
          sgxPass = { code: pass.publicCode, status: pass.status };
        }
      } catch {
        // La vista del resultado sigue funcionando aunque falle la consulta secundaria del PASS.
      }
    }
    try {
      const order = await getSgxOrderByJobId(job.id);
      purchaseNumber = order?.purchaseNumber ?? null;
      const orderBelongsToAuthorizedJob = Boolean(
        order
        && order.sgxPassId
        && (!job.sgxPassId || job.sgxPassId === order.sgxPassId)
        && (!job.customerId || job.customerId === order.customerId),
      );

      if (
        orderBelongsToAuthorizedJob
        && order
        && order.status === 'approved'
        && order.purchaseNumber
      ) {
        try {
          purchaseHistory = await getSgxPurchaseHistoryByPassId(order.sgxPassId, order.purchaseNumber);
        } catch {
          // History is additive; the current authorized purchase remains visible.
        }

        milestoneReadModel = await getSgxMilestoneReadModel(order.purchaseNumber);
        if (milestoneReadModel.next_milestone) {
          const progress = calculateMilestoneProgress({
            currentPurchaseNumber: order.purchaseNumber,
            previousMilestoneNumber: milestoneReadModel.next_milestone.previous_purchase_number,
            nextMilestoneNumber: milestoneReadModel.next_milestone.purchase_number,
          });
          milestoneProgress = {
            percentage: progress.percentage,
            remaining: progress.remaining.toString(),
            reached: progress.reached,
          };
        }
      }
    } catch {
      // El número es un dato adicional; no debe romper el resultado si falta la Order.
    }
  }

  const safePayload = {
    status: job.status,
    payment_status: job.paymentStatus,
    resultUrl: job.status === 'completed'
      ? `/api/image?jobId=${encodeURIComponent(job.id)}&token=${encodeURIComponent(accessToken)}`
      : null,
    sgxPass,
    purchase_number: purchaseNumber,
    purchase_history: purchaseHistory,
    next_milestone: milestoneReadModel.next_milestone,
    current_milestone: milestoneReadModel.current_milestone,
    milestone_progress: milestoneProgress,
    error: job.status === 'failed'
      ? job.metadata?.generation_error_category === 'moderation_blocked'
        ? MODERATION_GENERATION_ERROR
        : GENERIC_GENERATION_ERROR
      : null,
  };

  return new Response(JSON.stringify(safePayload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...privateNoStoreHeaders },
  });
};
