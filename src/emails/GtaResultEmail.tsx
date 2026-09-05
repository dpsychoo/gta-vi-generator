import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from 'react-email';
import type { CSSProperties } from 'react';
import { formatSgxviPurchaseNumber, PROJECT_PASS_DISPLAY_NAME } from '../lib/sgxvi-branding';

export type GtaResultEmailProps = {
  customerName?: string | null;
  customerEmail?: string | null;
  resultImageUrl: string;
  downloadUrl: string;
  orderId?: string | null;
  createdAt?: string | null;
  generatorUrl: string;
  sgxPassCode?: string | null;
  sgxPassStatus?: 'active' | 'suspended' | 'revoked' | null;
  purchaseNumber?: string | null;
};

const colors = {
  ink: '#080910',
  panel: '#11121d',
  panelRaised: '#18192a',
  panelSoft: '#202039',
  white: '#fffaff',
  muted: '#bdb8c9',
  pink: '#ff4fa3',
  orange: '#ff8a4c',
  violet: '#9e72ff',
};

const styles: Record<string, CSSProperties> = {
  body: {
    margin: 0,
    padding: 0,
    backgroundColor: colors.ink,
    color: colors.white,
    fontFamily: 'Arial, Helvetica, sans-serif',
  },
  shell: {
    width: '100%',
    maxWidth: 620,
    margin: '0 auto',
    backgroundColor: colors.panel,
    border: `1px solid ${colors.panelSoft}`,
  },
  masthead: {
    padding: '26px 34px 18px',
    backgroundColor: '#0d1020',
    borderBottom: `1px solid ${colors.panelSoft}`,
  },
  wordmark: {
    margin: 0,
    color: colors.white,
    fontSize: 22,
    lineHeight: '24px',
    fontWeight: 800,
    letterSpacing: 3,
  },
  wordmarkAccent: {
    color: colors.pink,
  },
  mastheadLabel: {
    margin: 0,
    color: colors.muted,
    fontSize: 10,
    lineHeight: '16px',
    fontWeight: 700,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
  },
  hero: {
    padding: '44px 34px 38px',
    backgroundColor: '#211536',
    backgroundImage: 'linear-gradient(135deg, #211536 0%, #291538 52%, #151a3a 100%)',
    borderBottom: `4px solid ${colors.pink}`,
  },
  eyebrow: {
    margin: '0 0 18px',
    color: colors.orange,
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 800,
    letterSpacing: 2.1,
    textTransform: 'uppercase',
  },
  title: {
    margin: 0,
    color: colors.white,
    fontSize: 42,
    lineHeight: '44px',
    fontWeight: 800,
    letterSpacing: -0.8,
  },
  titleAccent: {
    color: colors.pink,
  },
  subtitle: {
    margin: '20px 0 0',
    color: '#f7b6d7',
    fontSize: 16,
    lineHeight: '24px',
    fontWeight: 600,
  },
  content: {
    padding: '34px 34px 12px',
    backgroundColor: colors.panel,
  },
  greeting: {
    margin: '0 0 12px',
    color: colors.white,
    fontSize: 20,
    lineHeight: '28px',
    fontWeight: 700,
  },
  paragraph: {
    margin: '0 0 24px',
    color: colors.muted,
    fontSize: 15,
    lineHeight: '24px',
  },
  imagePanel: {
    padding: '10px 10px 12px',
    backgroundColor: '#0d1020',
    border: `1px solid #3d2b52`,
  },
  resultMeta: {
    padding: '2px 4px 11px',
  },
  resultMetaLabel: {
    margin: 0,
    color: '#ffb5d7',
    fontSize: 10,
    lineHeight: '15px',
    fontWeight: 800,
    letterSpacing: 1.4,
  },
  resultMetaStatus: {
    margin: 0,
    color: '#ffc477',
    fontSize: 9,
    lineHeight: '15px',
    fontWeight: 800,
    letterSpacing: 1,
  },
  resultImage: {
    display: 'block',
    width: '100%',
    maxWidth: 520,
    height: 'auto',
    border: 0,
  },
  buttonCell: {
    padding: '26px 0 8px',
    textAlign: 'center',
  },
  primaryButton: {
    display: 'inline-block',
    padding: '15px 25px',
    backgroundColor: colors.pink,
    backgroundImage: 'linear-gradient(100deg, #d93699 0%, #f16d67 52%, #6745e9 100%)',
    color: colors.white,
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: 800,
    letterSpacing: 1.3,
    textDecoration: 'none',
    borderRadius: 999,
    border: '1px solid #ff9ccc',
  },
  sectionLabel: {
    margin: '0 0 12px',
    color: colors.orange,
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 800,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
  },
  socialPanel: {
    marginTop: 24,
    padding: '25px 24px',
    backgroundColor: '#1a162c',
    border: '1px solid #4c315b',
  },
  socialTitle: {
    margin: '0 0 8px',
    color: colors.white,
    fontSize: 17,
    lineHeight: '24px',
    fontWeight: 800,
  },
  socialCopy: {
    margin: '0 0 18px',
    color: colors.muted,
    fontSize: 14,
    lineHeight: '22px',
  },
  socialButton: {
    display: 'inline-block',
    padding: '12px 18px',
    backgroundColor: colors.violet,
    color: colors.white,
    fontSize: 11,
    lineHeight: '15px',
    fontWeight: 800,
    letterSpacing: 1,
    textDecoration: 'none',
  },
  secondarySection: {
    padding: '30px 0 8px',
    textAlign: 'center',
  },
  secondaryLink: {
    color: '#ff9bc8',
    fontSize: 12,
    lineHeight: '18px',
    fontWeight: 800,
    letterSpacing: 1.2,
    textDecoration: 'underline',
  },
  details: {
    margin: '26px 0 0',
    padding: '18px 20px',
    backgroundColor: '#0d0e17',
    border: `1px solid ${colors.panelSoft}`,
  },
  passPanel: {
    marginTop: 24,
    padding: '25px 24px',
    backgroundColor: '#21142e',
    backgroundImage: 'linear-gradient(145deg, #2b1838 0%, #16142b 100%)',
    border: '1px solid #8a4d82',
  },
  passWelcome: {
    margin: 0,
    color: colors.orange,
    fontSize: 10,
    lineHeight: '15px',
    fontWeight: 800,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
  },
  passHeading: {
    margin: '8px 0 0',
    color: colors.white,
    fontSize: 25,
    lineHeight: '30px',
    fontWeight: 800,
    letterSpacing: 0.2,
  },
  passIntro: {
    margin: '12px 0 22px',
    color: colors.muted,
    fontSize: 13,
    lineHeight: '20px',
  },
  passCode: {
    margin: '5px 0 20px',
    padding: '13px 14px',
    backgroundColor: '#0d0f1b',
    border: '1px solid #71436f',
    color: colors.white,
    fontFamily: 'Courier New, Courier, monospace',
    fontSize: 22,
    lineHeight: '32px',
    fontWeight: 800,
    letterSpacing: 1.7,
    wordBreak: 'break-all',
    textAlign: 'center',
    textShadow: '0 0 14px rgba(255, 127, 194, 0.45)',
  },
  passLabel: {
    margin: 0,
    color: '#aa9fb9',
    fontSize: 10,
    lineHeight: '15px',
    fontWeight: 700,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  passValue: {
    margin: '3px 0 0',
    color: '#ffb5d7',
    fontSize: 13,
    lineHeight: '18px',
    fontWeight: 800,
    letterSpacing: 0.8,
  },
  passFootnote: {
    margin: '20px 0 0',
    color: colors.muted,
    fontSize: 13,
    lineHeight: '20px',
  },
  passEligibility: {
    margin: '16px 0 0',
    color: '#d1b8d0',
    fontSize: 12,
    lineHeight: '19px',
  },
  detailLabel: {
    margin: 0,
    color: '#8e899d',
    fontSize: 10,
    lineHeight: '16px',
    fontWeight: 700,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  detailValue: {
    margin: '3px 0 12px',
    color: '#eeeaf5',
    fontSize: 12,
    lineHeight: '18px',
    wordBreak: 'break-all',
  },
  footer: {
    padding: '24px 34px 32px',
  },
  footerBrand: {
    margin: '0 0 10px',
    color: '#ebe5f3',
    fontSize: 12,
    lineHeight: '18px',
    fontWeight: 800,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  disclaimer: {
    margin: 0,
    color: '#7d788b',
    fontSize: 11,
    lineHeight: '17px',
  },
};

function optionalDetail(label: string, value?: string | null) {
  if (!value) {
    return null;
  }

  return (
    <>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </>
  );
}

function getPassStatusLabel(status?: 'active' | 'suspended' | 'revoked' | null) {
  if (status === 'suspended') {
    return 'SUSPENDED';
  }
  if (status === 'revoked') {
    return 'REVOKED';
  }
  return status === 'active' ? 'ACTIVE' : 'PASS ISSUED';
}

export function GtaResultEmail({
  customerName,
  customerEmail,
  resultImageUrl,
  downloadUrl,
  orderId,
  createdAt,
  generatorUrl,
  sgxPassCode,
  sgxPassStatus,
  purchaseNumber,
}: GtaResultEmailProps) {
  const greeting = customerName?.trim() ? `Hola ${customerName.trim()} 👋` : 'Hola 👋';
  const passStatusLabel = getPassStatusLabel(sgxPassStatus);
  const purchaseLabel = formatSgxviPurchaseNumber(purchaseNumber);

  return (
    <Html lang="es">
      <Head />
      <Preview>Tu imagen SGODX ya está lista. Tu SGX · VI PASS es permanente.</Preview>
      <Body style={styles.body}>
        <Container style={styles.shell}>
          <Section style={styles.masthead}>
            <Row>
              <Column>
                <Text style={styles.wordmark}>
                  SGOD<span style={styles.wordmarkAccent}>X</span>
                </Text>
              </Column>
              <Column align="right">
                <Text style={styles.mastheadLabel}>GTA VI STYLE GENERATOR</Text>
              </Column>
            </Row>
          </Section>

          <Section style={styles.hero}>
            <Text style={styles.eyebrow}>SGODX · GTA VI STYLE GENERATOR</Text>
            <Heading as="h1" style={styles.title}>
              TU IMAGEN
              <br />
              <span style={styles.titleAccent}>YA ESTÁ LISTA</span>
            </Heading>
            <Text style={styles.subtitle}>Welcome to Vice City.</Text>
          </Section>

          <Section style={styles.content}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.paragraph}>
              Tu transformación se completó correctamente. Tu imagen está lista para descargar y compartir.
            </Text>

            <Section style={styles.imagePanel}>
              <Section style={styles.resultMeta}>
                <Row>
                  <Column>
                    <Text style={styles.resultMetaLabel}>YOUR SGODX RESULT</Text>
                  </Column>
                  <Column align="right">
                    <Text style={styles.resultMetaStatus}>● GENERATION COMPLETE</Text>
                  </Column>
                </Row>
              </Section>
              <Img
                src={resultImageUrl}
                width="520"
                alt="Tu imagen generada por SGODX"
                style={styles.resultImage}
              />
            </Section>

            <Section>
              <Row>
                <Column style={styles.buttonCell}>
                  <Button href={downloadUrl} style={styles.primaryButton}>
                    DESCARGAR IMAGEN ↓
                  </Button>
                </Column>
              </Row>
            </Section>

            {(sgxPassCode || purchaseLabel) && (
              <Section style={styles.passPanel}>
                <Text style={styles.passWelcome}>WELCOME TO THE SYSTEM</Text>
                <Heading as="h2" style={styles.passHeading}>{PROJECT_PASS_DISPLAY_NAME}</Heading>
                <Text style={styles.passIntro}>
                  Tu {PROJECT_PASS_DISPLAY_NAME} ya forma parte de tu identidad SGODX. Es permanente y conservarás el mismo en futuras experiencias.
                </Text>
                {sgxPassCode && (
                  <>
                    <Text style={styles.passLabel}>PASS CODE</Text>
                    <Text style={styles.passCode}>{sgxPassCode}</Text>
                    <Row>
                      <Column>
                        <Text style={styles.passLabel}>MEMBERSHIP</Text>
                        <Text style={styles.passValue}>PERMANENT</Text>
                      </Column>
                      <Column align="right">
                        <Text style={styles.passLabel}>PASS STATUS</Text>
                        <Text style={styles.passValue}>{passStatusLabel}</Text>
                      </Column>
                    </Row>
                  </>
                )}
                {purchaseLabel && (
                  <>
                    <Text style={styles.passLabel}>PURCHASE NUMBER</Text>
                    <Text style={styles.passValue}>{purchaseLabel}</Text>
                    <Text style={styles.passFootnote}>Tu número de compra dentro de SGX · VI.</Text>
                  </>
                )}
                <Text style={styles.passFootnote}>
                  Tu {PROJECT_PASS_DISPLAY_NAME} es permanente y se reutilizará en futuras misiones, sorteos, premios, dinámicas y eventos SGODX.
                </Text>
                <Text style={styles.passEligibility}>
                  Cada evento SGODX tendrá sus propias reglas y requisitos de participación.
                </Text>
              </Section>
            )}

            <Section style={styles.socialPanel}>
              <Text style={styles.sectionLabel}>COMPARTE EL MOMENTO</Text>
              <Text style={styles.socialTitle}>¿TE GUSTÓ EL RESULTADO?</Text>
              <Text style={styles.socialCopy}>
                Súbelo a tu historia, etiqueta a @sgodx_ y podrás aparecer en nuestro Instagram.
              </Text>
              <Button href="https://www.instagram.com/sgodx_/" style={styles.socialButton}>
                SEGUIR A @SGODX_
              </Button>
            </Section>

            <Section style={styles.secondarySection}>
              <Link href={generatorUrl} style={styles.secondaryLink}>
                CREAR OTRA IMAGEN
              </Link>
            </Section>

            {(customerEmail || createdAt) && (
              <Section style={styles.details}>
                <Text style={styles.sectionLabel}>DETALLES DE TU RESULTADO</Text>
                {optionalDetail('JOB / ORDER ID', orderId)}
                {optionalDetail('EMAIL', customerEmail)}
                {optionalDetail('FECHA', createdAt)}
              </Section>
            )}
          </Section>

          <Section style={styles.footer}>
            <Hr style={{ borderColor: colors.panelSoft, margin: '0 0 22px' }} />
            <Text style={styles.footerBrand}>SGODX · GTA VI STYLE GENERATOR</Text>
            <Text style={styles.disclaimer}>
              Esta experiencia es independiente. SGODX no está afiliado, patrocinado ni respaldado por Rockstar Games o Take-Two Interactive.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
