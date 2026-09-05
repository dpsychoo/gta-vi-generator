import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from 'react-email';
import type { CSSProperties } from 'react';
import { PROJECT_PASS_DISPLAY_NAME } from '../lib/sgxvi-branding';

export type PurchaseConfirmationEmailProps = {
  customerEmail: string;
  orderId: string;
  paymentId: string;
  approvedAt: string;
  termsVersion: string;
  privacyVersion: string;
  refundPolicyVersion: string;
  termsUrl: string;
  privacyUrl: string;
  refundsUrl: string;
  legalUrl: string;
  sgxPassCode?: string | null;
};

const colors = {
  ink: '#080910',
  panel: '#11121d',
  panelRaised: '#191a2b',
  white: '#fffaff',
  muted: '#c5bfd0',
  pink: '#ff4fa3',
  orange: '#ff9b5e',
  line: '#3b2b4e',
};

const styles: Record<string, CSSProperties> = {
  body: {
    margin: 0,
    padding: 0,
    backgroundColor: colors.ink,
    color: colors.white,
    fontFamily: 'Arial, Helvetica, sans-serif',
  },
  container: {
    width: '100%',
    maxWidth: 620,
    margin: '0 auto',
    backgroundColor: colors.panel,
    border: `1px solid ${colors.line}`,
  },
  header: {
    padding: '28px 32px 22px',
    backgroundColor: '#0e1020',
    borderBottom: `3px solid ${colors.pink}`,
  },
  eyebrow: {
    margin: 0,
    color: colors.orange,
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 800,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  wordmark: {
    margin: '8px 0 0',
    color: colors.white,
    fontSize: 25,
    lineHeight: '30px',
    fontWeight: 800,
    letterSpacing: 3,
  },
  content: {
    padding: '34px 32px 30px',
  },
  title: {
    margin: 0,
    color: colors.white,
    fontSize: 30,
    lineHeight: '36px',
    fontWeight: 800,
  },
  paragraph: {
    margin: '16px 0 0',
    color: colors.muted,
    fontSize: 15,
    lineHeight: '24px',
  },
  card: {
    marginTop: 26,
    padding: '20px 22px',
    backgroundColor: colors.panelRaised,
    border: `1px solid ${colors.line}`,
  },
  label: {
    margin: '0 0 7px',
    color: colors.orange,
    fontSize: 10,
    lineHeight: '15px',
    fontWeight: 800,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  value: {
    margin: 0,
    color: colors.white,
    fontSize: 15,
    lineHeight: '23px',
  },
  accent: {
    margin: '18px 0 0',
    color: '#ffb3d5',
    fontSize: 15,
    lineHeight: '23px',
    fontWeight: 700,
  },
  link: {
    color: '#ff9dc7',
    textDecoration: 'underline',
  },
  footer: {
    padding: '22px 32px 28px',
    borderTop: `1px solid ${colors.line}`,
  },
  footerText: {
    margin: 0,
    color: '#9e98aa',
    fontSize: 12,
    lineHeight: '19px',
  },
};

export function PurchaseConfirmationEmail(props: PurchaseConfirmationEmailProps) {
  return (
    <Html lang="es">
      <Head />
      <Preview>Confirmación de compra SGODX — $2.990 CLP</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.header}>
            <Text style={styles.eyebrow}>SGODX LEGAL CENTER</Text>
            <Text style={styles.wordmark}>SGODX</Text>
          </Section>
          <Section style={styles.content}>
            <Heading style={styles.title}>Pago confirmado</Heading>
            <Text style={styles.paragraph}>
              Recibimos tu pago por la generación personalizada de imagen. El procesamiento comienza automáticamente y recibirás el resultado en un correo separado cuando esté listo.
            </Text>
            <Section style={styles.card}>
              <Text style={styles.label}>Detalle del servicio</Text>
              <Text style={styles.value}>Generación personalizada de imagen mediante inteligencia artificial.</Text>
              <Text style={styles.value}>Total pagado: $2.990 CLP vía Mercado Pago.</Text>
              <Text style={styles.value}>Correo asociado: {props.customerEmail}</Text>
              <Text style={styles.value}>Orden: {props.orderId}</Text>
              <Text style={styles.value}>Pago: {props.paymentId}</Text>
              <Text style={styles.value}>Fecha: {props.approvedAt}</Text>
            </Section>
            <Section style={styles.card}>
              <Text style={styles.label}>{PROJECT_PASS_DISPLAY_NAME}</Text>
              {props.sgxPassCode && <Text style={styles.value}>{props.sgxPassCode}</Text>}
            </Section>
            <Text style={styles.accent}>
              Tu aceptación quedó registrada con Términos {props.termsVersion}, Privacidad {props.privacyVersion} y Reembolsos {props.refundPolicyVersion}.
            </Text>
            <Text style={styles.paragraph}>
              Al solicitar el inicio inmediato del servicio digital personalizado, reconociste la exclusión del derecho a retracto en los términos informados antes de la compra. Si tienes dudas sobre el servicio o un problema técnico, escríbenos a support@sgodx.com.
            </Text>
            <Section style={styles.card}>
              <Text style={styles.label}>Condiciones esenciales de retracto y reembolsos</Text>
              <Text style={styles.value}>El servicio digital personalizado comienza automáticamente después de confirmado el pago. SGODX SpA excluye el derecho a retracto conforme a las condiciones informadas y aceptadas antes de la compra.</Text>
              <Text style={styles.value}>No procede devolución voluntaria por arrepentimiento, cambio de opinión, disconformidad meramente subjetiva con el estilo o decisión posterior de no utilizar el resultado, cuando el servicio fue correctamente prestado.</Text>
              <Text style={styles.value}>Los cobros duplicados serán revisados. Si SGODX no puede prestar definitivamente el servicio por un fallo atribuible al servicio, se aplicará reintento, restablecimiento, entrega o la solución/restitución que corresponda.</Text>
              <Text style={styles.value}>Nada de lo anterior limita derechos irrenunciables establecidos por la legislación aplicable.</Text>
            </Section>
            <Text style={styles.paragraph}>
              Consulta el <Link href={props.legalUrl} style={styles.link}>Legal Center</Link>, los <Link href={props.termsUrl} style={styles.link}>Términos</Link>, la <Link href={props.privacyUrl} style={styles.link}>Privacidad</Link> y la <Link href={props.refundsUrl} style={styles.link}>Política de Reembolsos</Link>.
            </Text>
          </Section>
          <Section style={styles.footer}>
            <Text style={styles.footerText}>SGODX SpA · RUT 78.500.041-2 · Santiago de Apóstol 4191, La Serena, Región de Coquimbo, Chile</Text>
            <Text style={{ ...styles.footerText, marginTop: 8 }}>Este correo confirma una transacción y la aceptación de documentos legales versionados. SGODX no está afiliado, patrocinado ni respaldado por Rockstar Games o Take-Two Interactive.</Text>
          </Section>
          <Hr style={{ borderColor: colors.line, margin: 0 }} />
        </Container>
      </Body>
    </Html>
  );
}
