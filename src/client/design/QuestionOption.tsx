export type QuestionOptionProps = {
  name: string;
  value: string;
  label: string;
  checked?: boolean;
  onChange?: () => void;
};

export function QuestionOption({ name, value, label, checked = false, onChange }: QuestionOptionProps) {
  const id = `${name}-${value}`;
  return (
    <label className={["hr-question-option", checked ? "hr-question-option--checked" : ""].filter(Boolean).join(" ")} htmlFor={id}>
      <input id={id} type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      <span className="hr-question-option__control" aria-hidden="true" />
      <span className="hr-question-option__label">{label}</span>
    </label>
  );
}
