import { redirect } from "next/navigation";

/** A captura agora faz parte do Financial Agent. Mantém os links antigos funcionando. */
export default function LegacyCapturePage() {
  redirect("/agente/conexoes");
}
