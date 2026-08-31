export async function createMercadoPagoPreference({ jobId, email }: { jobId: string; email: string }) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:4321';
  const currency = process.env.JOB_CURRENCY || 'CLP';
  const unitPrice = Number(process.env.JOB_PRICE || '3000');

  if (!accessToken) {
    if (import.meta.env.PROD) {
      throw new Error('Falta MERCADOPAGO_ACCESS_TOKEN en producción');
    }
    return {
      init_point: `${appBaseUrl}/resultado?jobId=${jobId}&mockApproved=1`,
      mocked: true,
      sandbox: true,
      id: `mock_${jobId}`,
    };
  }

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [
        {
          title: 'Generación GTA VI',
          quantity: 1,
          unit_price: Number.isFinite(unitPrice) ? unitPrice : 3000,
          currency_id: currency,
        },
      ],
      payer: { email },
      external_reference: jobId,
      notification_url: `${appBaseUrl}/api/mercadopago-webhook`,
      back_urls: {
        success: `${appBaseUrl}/resultado?jobId=${jobId}&status=success`,
        failure: `${appBaseUrl}/resultado?jobId=${jobId}&status=failure`,
        pending: `${appBaseUrl}/resultado?jobId=${jobId}&status=pending`,
      },
      auto_return: 'approved',
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'No se pudo crear la preferencia de pago');
  }

  return {
    init_point: data.init_point || data.sandbox_init_point || `${appBaseUrl}/resultado?jobId=${jobId}`,
    id: data.id,
    mocked: false,
  };
}

export async function verifyMercadoPagoPayment(paymentId: string) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!accessToken) {
    return { status: 'approved', paymentId, mocked: true };
  }

  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('No se pudo verificar el pago');
  }

  const data = await response.json();
  return {
    status: data.status,
    paymentId: data.id,
    mocked: false,
  };
}
