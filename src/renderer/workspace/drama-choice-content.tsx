import { AlertDialog } from "@base-ui/react/alert-dialog";

export function DramaChoiceContent<Key extends string>({
  title,
  description,
  stats,
  note,
  options,
  select,
  cancel,
}: {
  title: string;
  description?: string;
  stats?: { label: string; value: number }[];
  note?: string;
  options: { key: Key; label: string; count?: number }[];
  select: (key: Key) => void;
  cancel: () => void;
}) {
  return (
    <>
      <header>
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description render={<section />}>
          {description}
          {stats && (
            <span className="studio-batch-stats">
              {stats.map((item) => (
                <span key={item.label}>
                  {item.label} <b>{item.value}</b>
                </span>
              ))}
            </span>
          )}
          {note && <small>{note}</small>}
        </AlertDialog.Description>
      </header>
      <section className="studio-batch-choices">
        {options.map((option, index) => (
          <button
            type="button"
            data-primary={index === 0 || undefined}
            key={option.key}
            onClick={() => select(option.key)}
          >
            <span>{option.label}</span>
            {option.count !== undefined && <small>{option.count} 个</small>}
          </button>
        ))}
      </section>
      <footer>
        <button type="button" onClick={cancel}>
          取消
        </button>
      </footer>
    </>
  );
}
