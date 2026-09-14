import {
  INVOICE_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  statusInfo,
} from "@/lib/format";

/** Petits composants d'affichage partagés (aucun état, aucune logique métier). */

export function Badge({ children, tone = "badge-neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function SubscriptionStatusBadge({ status }: { status: string | null | undefined }) {
  const info = statusInfo(SUBSCRIPTION_STATUS_LABELS, status);
  return <span className={`badge ${info.tone}`}>{info.label}</span>;
}

export function InvoiceStatusBadge({ status }: { status: string | null | undefined }) {
  const info = statusInfo(INVOICE_STATUS_LABELS, status);
  return <span className={`badge ${info.tone}`}>{info.label}</span>;
}

export function PaymentStatusBadge({ status }: { status: string | null | undefined }) {
  const info = statusInfo(PAYMENT_STATUS_LABELS, status);
  return <span className={`badge ${info.tone}`}>{info.label}</span>;
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "success" | "warning" | "danger";
}) {
  const color =
    tone === "success" ? "var(--success)" : tone === "warning" ? "var(--warning)" : tone === "danger" ? "var(--danger)" : undefined;
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`}>
      {title ? <strong style={{ display: "block", marginBottom: 3 }}>{title}</strong> : null}
      {children}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="section-title row-between">
      <h2>{children}</h2>
      {aside}
    </div>
  );
}

/** Barres CSS pures : aucun graphique externe, donc affichable hors ligne. */
export function BarChart({ points }: { points: Array<{ label: string; value: number; caption: string }> }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="chart">
      {points.map((point) => (
        <div key={point.label} className="chart-col" title={`${point.caption} — ${point.label}`}>
          <span className="chart-cap">{point.caption}</span>
          <div className="chart-bar" style={{ height: `${Math.max(2, (point.value / max) * 100)}%` }} />
          <span className="chart-cap">{point.label}</span>
        </div>
      ))}
    </div>
  );
}
