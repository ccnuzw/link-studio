import type { ChannelView, SettingsValues } from "@link-studio/core";
import { useEffect, useState } from "react";
import { ModelModal } from "../settings/model-editor";
import { useFilingPoll } from "../settings/use-filing-poll";

type Images = SettingsValues["filingAssets"];

export function HumanPicker({
  close,
  apply,
}: {
  close: () => void;
  apply: (channel: ChannelView, images: Images) => Promise<void>;
}) {
  const [channel, setChannel] = useState<ChannelView>();
  const [images, setImages] = useState<Images>([]);
  const [picked, setPicked] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [importing, setImporting] = useState(false);
  useFilingPoll(channel, images, loading || importing, setImages, setError);
  useEffect(() => {
    let current = true;
    async function load() {
      const channels = await window.desktop.settings.channelList({});
      if (!channels.ok) throw new Error();
      const filing = channels.value.find((candidate) => candidate.filing?.enabled);
      const result =
        filing &&
        (await window.desktop.settings.filingAssets({
          id: filing.id,
          expectedRevision: filing.revision,
          action: "list",
        }));
      if (result && !result.ok) throw new Error();
      if (current) {
        setChannel(filing);
        setImages(result?.value ?? []);
      }
    }
    setLoading(true);
    setError("");
    void load()
      .catch(() => {
        if (current) setError("真人库加载失败");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [retry]);
  const people = new Map<string, Images>();
  for (const image of images) {
    const members = people.get(image.humanId) ?? [];
    members.push(image);
    people.set(image.humanId, members);
  }
  const selected =
    people
      .get(picked)
      ?.filter((image) => image.status === "active" && image.hasSource)
      .sort((left, right) => left.order - right.order) ?? [];
  return (
    <ModelModal
      variant="human-picker"
      title="从真人库引入"
      close={() => {
        if (!importing) close();
      }}
    >
      <div className="human-picker-body" aria-busy={loading || importing}>
        {loading ? (
          <p role="status">加载中…</p>
        ) : !people.size && !error ? (
          <p>真人库是空的</p>
        ) : (
          <ul aria-label="真人">
            {Array.from(people, ([id, members]) => {
              const ready = members.filter(
                (image) => image.status === "active" && image.hasSource,
              ).length;
              const cover = members.find((image) => image.cover) ?? members[0]!;
              return (
                <li key={id}>
                  <button
                    type="button"
                    disabled={!ready || importing}
                    aria-pressed={id === picked}
                    onClick={() => setPicked(id)}
                  >
                    {channel && cover.hasSource && (
                      <FilingCover channel={channel} imageId={cover.id} />
                    )}
                    <span>{cover.humanName}</span>
                    <small>
                      {ready
                        ? `${ready} 张`
                        : members.some((image) => image.status === "processing")
                          ? "备案中"
                          : "不可用"}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p role="status">
            {error}{" "}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </p>
        )}
      </div>
      <footer className="model-dialog-footer">
        <button type="button" disabled={importing} onClick={close}>
          取消
        </button>
        <button
          type="button"
          disabled={loading || importing || !selected.length}
          onClick={async () => {
            if (!channel) return;
            setImporting(true);
            try {
              await apply(channel, selected);
              close();
            } catch {
              setError("图片引入失败，请重试。");
            } finally {
              setImporting(false);
            }
          }}
        >
          {importing ? "引入中…" : "引入"}
        </button>
      </footer>
    </ModelModal>
  );
}

export function FilingCover({ channel, imageId }: { channel: ChannelView; imageId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void window.desktop.settings
      .filingPreview({ id: channel.id, expectedRevision: channel.revision, assetId: imageId })
      .then((result) => {
        if (current && result.ok) setUrl(result.value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [channel.id, channel.revision, imageId]);
  return url ? <img src={url} alt="" /> : null;
}
