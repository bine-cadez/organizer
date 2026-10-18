import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AreaId, Item } from "../shared/types";

export function Icon({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  return (
    <img
      className={`icon ${className}`}
      src={`/design/${name}.svg`}
      alt=""
      aria-hidden="true"
    />
  );
}
export const areaNames: Record<AreaId, string> = {
  tech: "Tech",
  sales: "Sales & Business",
  ship: "Product Shipping",
  self: "General",
};
export function Tile({
  area,
  large = false,
}: {
  area: AreaId;
  large?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`area-tile ${area} ${large ? "large" : ""}`}
    >
      {{ tech: "T", sales: "S", ship: "P", self: "G" }[area]}
    </span>
  );
}
export function Lamp({ open }: { open: boolean }) {
  return (
    <span className={`lamp ${open ? "open" : "reserved"}`} aria-hidden="true" />
  );
}
export function Button({
  children,
  primary,
  ghost,
  small,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  ghost?: boolean;
  small?: boolean;
}) {
  return (
    <button
      className={`button ${primary ? "primary" : ""} ${ghost ? "ghost" : ""} ${small ? "small" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="header-actions">{children}</div>}
    </header>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <p>{title}</p>
      {children && <div>{children}</div>}
    </div>
  );
}
export function Cover({
  item,
  className = "",
}: {
  item: Pick<Item, "title" | "authors" | "coverUrl" | "areaId">;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.coverUrl]);
  if (item.coverUrl && !failed)
    return (
      <img
        className={`cover ${className}`}
        src={item.coverUrl}
        alt={`Cover of ${item.title}`}
        onError={() => setFailed(true)}
        loading="lazy"
      />
    );
  return (
    <div
      className={`cover title-card ${item.areaId} ${className}`}
      role="img"
      aria-label={`No cover found for ${item.title}`}
    >
      <strong>{item.title}</strong>
      <span>{item.authors?.join(", ")}</span>
    </div>
  );
}
export function Progress({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total || 1}
      aria-valuenow={current}
    >
      <span
        style={{
          width: `${total ? Math.min(100, (current / total) * 100) : 0}%`,
        }}
      />
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  drawer = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement;
    ref.current?.showModal();
    ref.current
      ?.querySelector<HTMLElement>(
        'input:not([type="checkbox"]):not([type="hidden"]), textarea',
      )
      ?.focus();
    return () => {
      ref.current?.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${drawer ? "drawer" : ""} ${className}`}
      aria-labelledby={heading}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <h2 id={heading}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ErrorText({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="error-text">
      {message}
    </p>
  ) : null;
}
export function Segment({
  values,
  value,
  onChange,
  label,
}: {
  values: { id: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="segments" role="group" aria-label={label}>
      {values.map((v) => (
        <button
          type="button"
          key={v.id}
          aria-pressed={value === v.id}
          className={value === v.id ? "selected" : ""}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
