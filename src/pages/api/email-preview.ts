import { createElement } from 'react';
import type { APIRoute } from 'astro';
import { render } from 'react-email';
import { GtaResultEmail } from '../../emails/GtaResultEmail';

export const prerender = false;

export const GET: APIRoute = async () => {
  if (import.meta.env.PROD) {
    return new Response('Not found', { status: 404 });
  }

  const html = await render(createElement(GtaResultEmail, {
    customerName: null,
    customerEmail: 'preview@example.com',
    resultImageUrl: 'https://placehold.co/1200x1200/1a1028/ff4fa3.png?text=SGODX+RESULT',
    downloadUrl: 'https://example.com/resultado?jobId=preview&token=preview',
    orderId: 'preview-job-0001',
    createdAt: '2 sept 2026, 21:30',
    generatorUrl: 'https://example.com/',
    sgxPassCode: 'SGX-PREVIEW-0001',
    sgxPassStatus: 'active',
    purchaseNumber: '4',
  }));

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
