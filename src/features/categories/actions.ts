"use server";

import { revalidatePath } from "next/cache";
import {
  dbErrorMessage,
  type ActionResult,
  type FieldErrors,
} from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import {
  categoryFormSchema,
  categoryIdSchema,
  findDuplicateCategory,
  uniqueSlug,
} from "./schema";

const NOT_FOUND = "Categoria não encontrada.";
const ENTITY = "transaction_category";

function parseForm(formData: FormData) {
  const parsed = categoryFormSchema.safeParse({
    name: formData.get("name") ?? "",
    kind: formData.get("kind") ?? "",
    icon: formData.get("icon") ?? "",
    color: formData.get("color") ?? "",
  });
  if (parsed.success) return { ok: true as const, data: parsed.data };

  const fieldErrors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
  }
  return { ok: false as const, fieldErrors };
}

const INVALID_FORM = "Revise os campos destacados.";
const DUPLICATE: ActionResult = {
  ok: false,
  error: "Já existe uma categoria ativa com esse nome nesse tipo.",
  fieldErrors: { name: "Escolha outro nome." },
};

export async function createCategory(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const form = parseForm(formData);
  if (!form.ok) return { ok: false, error: INVALID_FORM, fieldErrors: form.fieldErrors };

  const { data: existing, error: readError } = await auth.supabase
    .from("transaction_categories")
    .select("id,name,kind,archived,slug");
  if (readError) return { ok: false, error: dbErrorMessage(readError, "categories.read") };

  if (findDuplicateCategory(form.data, existing)) return DUPLICATE;

  const slug = uniqueSlug(form.data.name, existing.map((c) => c.slug));
  const { data, error } = await auth.supabase
    .from("transaction_categories")
    .insert({ ...form.data, slug, user_id: auth.user.id })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbErrorMessage(error, "categories.create") };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "category.created",
    entityType: ENTITY,
    entityId: data.id,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Categoria criada." };
}

export async function updateCategory(
  categoryId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!categoryIdSchema.safeParse(categoryId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const form = parseForm(formData);
  if (!form.ok) return { ok: false, error: INVALID_FORM, fieldErrors: form.fieldErrors };

  const { data: existing, error: readError } = await auth.supabase
    .from("transaction_categories")
    .select("id,name,kind,archived");
  if (readError) return { ok: false, error: dbErrorMessage(readError, "categories.read") };

  if (findDuplicateCategory(form.data, existing, categoryId)) return DUPLICATE;

  const { data, error } = await auth.supabase
    .from("transaction_categories")
    .update(form.data)
    .eq("id", categoryId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: dbErrorMessage(error, "categories.update") };
  if (!data) return { ok: false, error: NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "category.updated",
    entityType: ENTITY,
    entityId: categoryId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Categoria atualizada." };
}

async function setArchived(categoryId: string, archived: boolean): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!categoryIdSchema.safeParse(categoryId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const { data, error } = await auth.supabase
    .from("transaction_categories")
    .update({ archived })
    .eq("id", categoryId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: dbErrorMessage(error, "categories.archive") };
  if (!data) return { ok: false, error: NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: archived ? "category.archived" : "category.unarchived",
    entityType: ENTITY,
    entityId: categoryId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: archived ? "Categoria arquivada." : "Categoria reativada." };
}

export async function archiveCategory(categoryId: string): Promise<ActionResult> {
  return setArchived(categoryId, true);
}

export async function unarchiveCategory(categoryId: string): Promise<ActionResult> {
  return setArchived(categoryId, false);
}

/** Só categorias próprias e sem lançamentos. O banco recusa as que estão em uso. */
export async function deleteCategory(categoryId: string): Promise<ActionResult> {
  const auth = await requireUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!categoryIdSchema.safeParse(categoryId).success) {
    return { ok: false, error: NOT_FOUND };
  }

  const { data, error } = await auth.supabase
    .from("transaction_categories")
    .delete()
    .eq("id", categoryId)
    .eq("is_system", false)
    .select("id")
    .maybeSingle();

  if (error?.code === "23503") {
    return {
      ok: false,
      error: "Esta categoria tem lançamentos e não pode ser excluída. Arquive-a.",
    };
  }
  if (error) return { ok: false, error: dbErrorMessage(error, "categories.delete") };
  if (!data) return { ok: false, error: NOT_FOUND };

  await logAudit(auth.supabase, {
    userId: auth.user.id,
    event: "category.deleted",
    entityType: ENTITY,
    entityId: categoryId,
  });

  revalidatePath("/", "layout");
  return { ok: true, message: "Categoria excluída." };
}
