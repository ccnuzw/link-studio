import { CircleCheck, Info, OctagonX } from "lucide-react";
import { Toaster, toast } from "sonner";
import "./canvas-toaster.css";

export const canvasNotice = { toasterId: "canvas-actions" };

export function reportLinkNotice(message: string) {
  toast.info(message, canvasNotice);
}

export function reportFillError(message: string) {
  toast.error(message, { ...canvasNotice, id: "fill-upload" });
}

export function CanvasToaster() {
  return (
    <Toaster
      id={canvasNotice.toasterId}
      className="canvas-toaster"
      position="top-center"
      theme="system"
      icons={{
        success: <CircleCheck size={16} />,
        error: <OctagonX size={16} />,
        info: <Info size={16} />,
      }}
    />
  );
}
