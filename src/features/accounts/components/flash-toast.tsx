"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";

/** Mostra uma vez o aviso trazido por um redirect e limpa a URL. */
export function FlashToast({ message, path }: { message: string; path: string }) {
  const toast = useToast();
  const router = useRouter();
  const shown = useRef(false);

  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    toast.success(message);
    router.replace(path, { scroll: false });
  }, [message, path, router, toast]);

  return null;
}
