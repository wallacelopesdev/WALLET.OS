import { Card, CardTitle } from "@/components/ui/card";

/** O código está à frente do banco: indica a migration que falta aplicar. */
export function MigrationNotice({ file }: { file: string }) {
  return (
    <Card className="animate-rise">
      <CardTitle>Banco de dados desatualizado</CardTitle>
      <p className="mt-3 max-w-xl text-sm text-muted">
        Este módulo precisa da migration{" "}
        <code className="break-all text-fg">supabase/migrations/{file}</code>.
        Abra o SQL Editor do Supabase, cole o conteúdo do arquivo, execute e
        recarregue esta página. Se houver migrations anteriores pendentes,
        aplique-as antes, em ordem numérica. Seus dados são preservados.
      </p>
    </Card>
  );
}
