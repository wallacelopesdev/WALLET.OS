-- WALLET OS — Fase 2, Módulo 3 (parte 1 de 2): novo tipo de lançamento.
--
-- Fica em um arquivo próprio porque o Postgres não permite usar um valor de enum
-- na mesma transação que o criou. Execute este arquivo e depois o 0005.
alter type public.tx_kind add value if not exists 'expense';
