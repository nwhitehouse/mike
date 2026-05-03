-- Enable RLS for tenant-sensitive tables.
--
-- The backend uses a service-role client after app-layer authorization, so
-- these policies primarily protect direct Supabase client access and provide
-- defense-in-depth if an app-layer check is missed.

create or replace function public.current_user_id_text()
returns text
language sql
stable
as $$
  select auth.uid()::text
$$;

create or replace function public.current_user_email_text()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.can_access_project(project_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = project_uuid
      and (
        p.user_id = public.current_user_id_text()
        or p.shared_with ? public.current_user_email_text()
      )
  )
$$;

create or replace function public.can_access_document(document_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.documents d
    where d.id = document_uuid
      and (
        d.user_id = public.current_user_id_text()
        or (d.project_id is not null and public.can_access_project(d.project_id))
      )
  )
$$;

create or replace function public.can_access_review(review_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tabular_reviews tr
    where tr.id = review_uuid
      and (
        tr.user_id = public.current_user_id_text()
        or tr.shared_with ? public.current_user_email_text()
        or (tr.project_id is not null and public.can_access_project(tr.project_id))
      )
  )
$$;

create or replace function public.can_access_chat(chat_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chats c
    where c.id = chat_uuid
      and (
        c.user_id = public.current_user_id_text()
        or (c.project_id is not null and public.can_access_project(c.project_id))
      )
  )
$$;

create or replace function public.can_access_tabular_chat(chat_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tabular_review_chats c
    where c.id = chat_uuid
      and public.can_access_review(c.review_id)
  )
$$;

create or replace function public.can_access_workflow(workflow_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workflows w
    where w.id = workflow_uuid
      and (
        w.is_system
        or w.user_id = public.current_user_id_text()
        or exists (
          select 1
          from public.workflow_shares ws
          where ws.workflow_id = w.id
            and ws.shared_with_email = public.current_user_email_text()
        )
      )
  )
$$;

alter table public.projects enable row level security;
alter table public.project_subfolders enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_edits enable row level security;
alter table public.workflows enable row level security;
alter table public.hidden_workflows enable row level security;
alter table public.workflow_shares enable row level security;
alter table public.chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.tabular_reviews enable row level security;
alter table public.tabular_cells enable row level security;
alter table public.tabular_review_chats enable row level security;
alter table public.tabular_review_chat_messages enable row level security;

drop policy if exists projects_select_access on public.projects;
create policy projects_select_access on public.projects
  for select using (
    user_id = public.current_user_id_text()
    or shared_with ? public.current_user_email_text()
  );

drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner on public.projects
  for insert with check (user_id = public.current_user_id_text());

drop policy if exists projects_update_owner on public.projects;
create policy projects_update_owner on public.projects
  for update using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists projects_delete_owner on public.projects;
create policy projects_delete_owner on public.projects
  for delete using (user_id = public.current_user_id_text());

drop policy if exists project_subfolders_project_access on public.project_subfolders;
create policy project_subfolders_project_access on public.project_subfolders
  for select using (public.can_access_project(project_id));

drop policy if exists project_subfolders_insert_access on public.project_subfolders;
create policy project_subfolders_insert_access on public.project_subfolders
  for insert with check (
    user_id = public.current_user_id_text()
    and public.can_access_project(project_id)
  );

drop policy if exists project_subfolders_update_access on public.project_subfolders;
create policy project_subfolders_update_access on public.project_subfolders
  for update using (public.can_access_project(project_id))
  with check (public.can_access_project(project_id));

drop policy if exists project_subfolders_delete_access on public.project_subfolders;
create policy project_subfolders_delete_access on public.project_subfolders
  for delete using (public.can_access_project(project_id));

drop policy if exists documents_select_access on public.documents;
create policy documents_select_access on public.documents
  for select using (
    user_id = public.current_user_id_text()
    or (project_id is not null and public.can_access_project(project_id))
  );

drop policy if exists documents_insert_access on public.documents;
create policy documents_insert_access on public.documents
  for insert with check (
    user_id = public.current_user_id_text()
    and (project_id is null or public.can_access_project(project_id))
  );

drop policy if exists documents_update_access on public.documents;
create policy documents_update_access on public.documents
  for update using (
    user_id = public.current_user_id_text()
    or (project_id is not null and public.can_access_project(project_id))
  )
  with check (
    user_id = public.current_user_id_text()
    or (project_id is not null and public.can_access_project(project_id))
  );

drop policy if exists documents_delete_owner on public.documents;
create policy documents_delete_owner on public.documents
  for delete using (user_id = public.current_user_id_text());

drop policy if exists document_versions_doc_access on public.document_versions;
create policy document_versions_doc_access on public.document_versions
  for select using (public.can_access_document(document_id));

drop policy if exists document_versions_insert_doc_access on public.document_versions;
create policy document_versions_insert_doc_access on public.document_versions
  for insert with check (public.can_access_document(document_id));

drop policy if exists document_versions_update_doc_access on public.document_versions;
create policy document_versions_update_doc_access on public.document_versions
  for update using (public.can_access_document(document_id))
  with check (public.can_access_document(document_id));

drop policy if exists document_versions_delete_doc_owner on public.document_versions;
create policy document_versions_delete_doc_owner on public.document_versions
  for delete using (public.can_access_document(document_id));

drop policy if exists document_edits_doc_access on public.document_edits;
create policy document_edits_doc_access on public.document_edits
  for select using (public.can_access_document(document_id));

drop policy if exists document_edits_insert_doc_access on public.document_edits;
create policy document_edits_insert_doc_access on public.document_edits
  for insert with check (public.can_access_document(document_id));

drop policy if exists document_edits_update_doc_access on public.document_edits;
create policy document_edits_update_doc_access on public.document_edits
  for update using (public.can_access_document(document_id))
  with check (public.can_access_document(document_id));

drop policy if exists document_edits_delete_doc_access on public.document_edits;
create policy document_edits_delete_doc_access on public.document_edits
  for delete using (public.can_access_document(document_id));

drop policy if exists workflows_select_access on public.workflows;
create policy workflows_select_access on public.workflows
  for select using (public.can_access_workflow(id));

drop policy if exists workflows_insert_owner on public.workflows;
create policy workflows_insert_owner on public.workflows
  for insert with check (
    coalesce(is_system, false) = false
    and user_id = public.current_user_id_text()
  );

drop policy if exists workflows_update_owner_or_editor on public.workflows;
create policy workflows_update_owner_or_editor on public.workflows
  for update using (
    coalesce(is_system, false) = false
    and (
      user_id = public.current_user_id_text()
      or exists (
        select 1
        from public.workflow_shares ws
        where ws.workflow_id = workflows.id
          and ws.shared_with_email = public.current_user_email_text()
          and ws.allow_edit
      )
    )
  )
  with check (coalesce(is_system, false) = false);

drop policy if exists workflows_delete_owner on public.workflows;
create policy workflows_delete_owner on public.workflows
  for delete using (
    coalesce(is_system, false) = false
    and user_id = public.current_user_id_text()
  );

drop policy if exists hidden_workflows_owner on public.hidden_workflows;
create policy hidden_workflows_owner on public.hidden_workflows
  for all using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists workflow_shares_select_access on public.workflow_shares;
create policy workflow_shares_select_access on public.workflow_shares
  for select using (
    shared_by_user_id = public.current_user_id_text()
    or shared_with_email = public.current_user_email_text()
  );

drop policy if exists workflow_shares_insert_owner on public.workflow_shares;
create policy workflow_shares_insert_owner on public.workflow_shares
  for insert with check (
    shared_by_user_id = public.current_user_id_text()
    and exists (
      select 1 from public.workflows w
      where w.id = workflow_id
        and w.user_id = public.current_user_id_text()
        and coalesce(w.is_system, false) = false
    )
  );

drop policy if exists workflow_shares_update_owner on public.workflow_shares;
create policy workflow_shares_update_owner on public.workflow_shares
  for update using (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_id
        and w.user_id = public.current_user_id_text()
        and coalesce(w.is_system, false) = false
    )
  )
  with check (shared_by_user_id = public.current_user_id_text());

drop policy if exists workflow_shares_delete_owner on public.workflow_shares;
create policy workflow_shares_delete_owner on public.workflow_shares
  for delete using (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_id
        and w.user_id = public.current_user_id_text()
        and coalesce(w.is_system, false) = false
    )
  );

drop policy if exists chats_select_access on public.chats;
create policy chats_select_access on public.chats
  for select using (
    user_id = public.current_user_id_text()
    or (project_id is not null and public.can_access_project(project_id))
  );

drop policy if exists chats_insert_access on public.chats;
create policy chats_insert_access on public.chats
  for insert with check (
    user_id = public.current_user_id_text()
    and (project_id is null or public.can_access_project(project_id))
  );

drop policy if exists chats_update_owner on public.chats;
create policy chats_update_owner on public.chats
  for update using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists chats_delete_owner on public.chats;
create policy chats_delete_owner on public.chats
  for delete using (user_id = public.current_user_id_text());

drop policy if exists chat_messages_chat_access on public.chat_messages;
create policy chat_messages_chat_access on public.chat_messages
  for select using (public.can_access_chat(chat_id));

drop policy if exists chat_messages_insert_chat_access on public.chat_messages;
create policy chat_messages_insert_chat_access on public.chat_messages
  for insert with check (public.can_access_chat(chat_id));

drop policy if exists chat_messages_update_chat_access on public.chat_messages;
create policy chat_messages_update_chat_access on public.chat_messages
  for update using (public.can_access_chat(chat_id))
  with check (public.can_access_chat(chat_id));

drop policy if exists chat_messages_delete_chat_owner on public.chat_messages;
create policy chat_messages_delete_chat_owner on public.chat_messages
  for delete using (public.can_access_chat(chat_id));

drop policy if exists tabular_reviews_select_access on public.tabular_reviews;
create policy tabular_reviews_select_access on public.tabular_reviews
  for select using (
    user_id = public.current_user_id_text()
    or shared_with ? public.current_user_email_text()
    or (project_id is not null and public.can_access_project(project_id))
  );

drop policy if exists tabular_reviews_insert_access on public.tabular_reviews;
create policy tabular_reviews_insert_access on public.tabular_reviews
  for insert with check (
    user_id = public.current_user_id_text()
    and (project_id is null or public.can_access_project(project_id))
  );

drop policy if exists tabular_reviews_update_access on public.tabular_reviews;
create policy tabular_reviews_update_access on public.tabular_reviews
  for update using (public.can_access_review(id))
  with check (public.can_access_review(id));

drop policy if exists tabular_reviews_delete_owner on public.tabular_reviews;
create policy tabular_reviews_delete_owner on public.tabular_reviews
  for delete using (user_id = public.current_user_id_text());

drop policy if exists tabular_cells_review_access on public.tabular_cells;
create policy tabular_cells_review_access on public.tabular_cells
  for select using (public.can_access_review(review_id));

drop policy if exists tabular_cells_insert_review_access on public.tabular_cells;
create policy tabular_cells_insert_review_access on public.tabular_cells
  for insert with check (public.can_access_review(review_id));

drop policy if exists tabular_cells_update_review_access on public.tabular_cells;
create policy tabular_cells_update_review_access on public.tabular_cells
  for update using (public.can_access_review(review_id))
  with check (public.can_access_review(review_id));

drop policy if exists tabular_cells_delete_review_access on public.tabular_cells;
create policy tabular_cells_delete_review_access on public.tabular_cells
  for delete using (public.can_access_review(review_id));

drop policy if exists tabular_review_chats_review_access on public.tabular_review_chats;
create policy tabular_review_chats_review_access on public.tabular_review_chats
  for select using (public.can_access_review(review_id));

drop policy if exists tabular_review_chats_insert_review_access on public.tabular_review_chats;
create policy tabular_review_chats_insert_review_access on public.tabular_review_chats
  for insert with check (
    user_id = public.current_user_id_text()
    and public.can_access_review(review_id)
  );

drop policy if exists tabular_review_chats_update_review_access on public.tabular_review_chats;
create policy tabular_review_chats_update_review_access on public.tabular_review_chats
  for update using (public.can_access_review(review_id))
  with check (public.can_access_review(review_id));

drop policy if exists tabular_review_chats_delete_owner on public.tabular_review_chats;
create policy tabular_review_chats_delete_owner on public.tabular_review_chats
  for delete using (user_id = public.current_user_id_text());

drop policy if exists tabular_review_chat_messages_chat_access on public.tabular_review_chat_messages;
create policy tabular_review_chat_messages_chat_access on public.tabular_review_chat_messages
  for select using (public.can_access_tabular_chat(chat_id));

drop policy if exists tabular_review_chat_messages_insert_chat_access on public.tabular_review_chat_messages;
create policy tabular_review_chat_messages_insert_chat_access on public.tabular_review_chat_messages
  for insert with check (public.can_access_tabular_chat(chat_id));

drop policy if exists tabular_review_chat_messages_update_chat_access on public.tabular_review_chat_messages;
create policy tabular_review_chat_messages_update_chat_access on public.tabular_review_chat_messages
  for update using (public.can_access_tabular_chat(chat_id))
  with check (public.can_access_tabular_chat(chat_id));

drop policy if exists tabular_review_chat_messages_delete_chat_access on public.tabular_review_chat_messages;
create policy tabular_review_chat_messages_delete_chat_access on public.tabular_review_chat_messages
  for delete using (public.can_access_tabular_chat(chat_id));
