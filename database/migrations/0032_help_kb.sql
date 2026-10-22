-- The help assistant's knowledge base: chunks of the platform's own documentation (never user data), each with an embedding, and a
-- question log that keeps no question text. Embeddings are stored as real[] and compared in the API process: the corpus is a few
-- hundred chunks, and this works on any Postgres (no extension to install).
CREATE TABLE help_chunks (
  id            text PRIMARY KEY,                       -- <source>#<n>
  source        text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),   -- docs-relative path of the page
  heading       text NOT NULL CHECK (length(heading) <= 300),
  route         text CHECK (route IS NULL OR route ~ '^/admin(/[A-Za-z0-9._\[\]-]+)*$'),   -- the console page this text is about
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  content_hash  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  model         text NOT NULL,                          -- the embedding model; a changed model re-embeds everything
  embedding     real[] NOT NULL,
  indexed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX help_chunks_source ON help_chunks (source);
-- One row per question: who asked, a hash and the length of the question (not the text), what answered it, whether it helped.
-- Rows with no sources or a "no" are the gaps in the documentation.
CREATE TABLE help_questions (
  id            bigserial PRIMARY KEY,
  admin_id      text NOT NULL,
  question_hash text NOT NULL CHECK (question_hash ~ '^[0-9a-f]{64}$'),
  question_len  integer NOT NULL CHECK (question_len BETWEEN 0 AND 4000),
  sources       text[] NOT NULL DEFAULT '{}',
  answered      boolean NOT NULL,                       -- false: nothing relevant was documented, the model was not called
  helpful       boolean,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX help_questions_time ON help_questions (created_at DESC);

GRANT SELECT ON help_chunks, help_questions TO ao_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON help_chunks TO ao_admin;
GRANT SELECT, INSERT, UPDATE ON help_questions TO ao_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ao_admin;
