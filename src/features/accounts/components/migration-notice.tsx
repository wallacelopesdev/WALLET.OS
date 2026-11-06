import { Card, CardTitle } from "@/components/ui/card";

export function MigrationNotice() {
  return (
    <Card className="animate-rise">
      <CardTitle>Banco de dados desatualizado</CardTitle>
      <p className="mt-3 max-w-xl text-sm text-muted">
        Este módulo precisa da migration{" "}
        <code className="text-fg">supabase/migrations/0002_accounts.sql</code>.
        Abra o SQL Editor do Supabase, cole o conteúdo do arquivo, execute e
        recarregue esta página. Seus saldos atuais são preservados.
      </p>
    </Card>
  );
}
