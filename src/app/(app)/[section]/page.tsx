import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardTitle, PageHeader } from "@/components/ui/card";

type Section = {
  title: string;
  phase: number;
  summary: string;
  items: string[];
};

const SECTIONS: Record<string, Section> = {
  cartoes: {
    title: "Cartões",
    phase: 2,
    summary: "Controle de limite, fatura e parcelas de cada cartão.",
    items: [
      "Cadastro manual de limite, fechamento e vencimento",
      "Fatura atual, próximas faturas e histórico de uso",
      "Compras parceladas",
    ],
  },
  transacoes: {
    title: "Transações",
    phase: 2,
    summary: "Todas as movimentações em um só lugar.",
    items: [
      "Busca e filtros por período, conta, cartão e categoria",
      "Edição de categoria e histórico de importações",
    ],
  },
  relatorios: {
    title: "Relatórios",
    phase: 2,
    summary: "Relatórios diário, semanal, mensal e anual.",
    items: [
      "Exportação em PDF",
      "Padrões de consumo, gastos excessivos e oportunidades de economia",
    ],
  },
  "chief-of-staff": {
    title: "Chief of Staff",
    phase: 3,
    summary: "Seu assistente executivo pessoal.",
    items: [
      "Resumo diário: compromissos, e-mails, tarefas e prioridades",
      "Painel de atividades integrado a agenda, e-mails e tarefas",
    ],
  },
  emails: {
    title: "E-mails",
    phase: 3,
    summary: "Gmail com resumo, prioridade e rascunhos revisados por você.",
    items: [
      "Conexão segura via OAuth 2.0 (tokens criptografados)",
      "Resumo, prioridade, cobranças, convites e prazos",
      "Caixa de revisão: nenhum e-mail é enviado sem sua aprovação",
    ],
  },
  agenda: {
    title: "Agenda",
    phase: 3,
    summary: "Google Calendar com detecção de conflitos.",
    items: [
      "Visões diária e semanal",
      "Criar, editar e cancelar (com confirmação) compromissos",
      "Sugestão de horários livres",
    ],
  },
  tarefas: {
    title: "Tarefas",
    phase: 3,
    summary: "Gerenciador completo de tarefas e projetos.",
    items: [
      "Prioridade, prazo, status, categoria e projeto",
      "Criação de tarefas a partir de texto livre no chat",
    ],
  },
  assistant: {
    title: "AI Assistant",
    phase: 4,
    summary: "Chat central que consulta e age sobre todos os módulos.",
    items: [
      "Ferramentas específicas por módulo",
      "Confirmação obrigatória para ações sensíveis e registro de execução",
      "E-mails e documentos tratados como conteúdo não confiável",
    ],
  },
};

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(SECTIONS).map((section) => ({ section }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ section: string }>;
}): Promise<Metadata> {
  const { section } = await params;
  return { title: SECTIONS[section]?.title ?? "WALLET OS" };
}

export default async function SectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const data = SECTIONS[section];
  if (!data) notFound();

  return (
    <>
      <PageHeader
        title={data.title}
        subtitle={data.summary}
        badge={`Fase ${data.phase}`}
      />
      <Card className="animate-rise">
        <CardTitle>Planejado para a Fase {data.phase}</CardTitle>
        <ul className="mt-4 space-y-3 text-sm">
          {data.items.map((item) => (
            <li key={item} className="flex gap-3 text-muted">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-fg" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-6 text-xs text-faint">
          Este módulo ainda não foi implementado. A navegação, a autenticação e
          o banco de dados já estão prontos para recebê-lo.
        </p>
      </Card>
    </>
  );
}
