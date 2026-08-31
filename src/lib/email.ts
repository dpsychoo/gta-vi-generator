export async function sendJobResultEmail(email: string, resultUrl: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:4321';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@your-domain.com';

  if (!apiKey) {
    console.log(`[email] Fallback mock: ${email} -> ${resultUrl || `${appBaseUrl}/resultado`}`);
    return { ok: true, mocked: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject: 'Tu imagen GTA VI ya está lista',
      html: `
        <div style="font-family: Arial, sans-serif; color: #111;">
          <h2>Tu imagen ya está lista</h2>
          <p>Puedes verla aquí:</p>
          <a href="${resultUrl}">${resultUrl}</a>
        </div>
      `,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'No se pudo enviar el correo');
  }

  return { ok: true, mocked: false, id: data.id };
}
