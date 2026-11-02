export type DataChipProps = {
  label: string;
  value?: string;
};

export function DataChip({ label, value }: DataChipProps) {
  return (
    <span className="hr-data-chip">
      <span className="hr-data-chip__label">{label}</span>
      {value ? <span className="hr-data-chip__value">{value}</span> : null}
    </span>
  );
}
