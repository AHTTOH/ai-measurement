CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"subquestion_key" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"is_final" boolean NOT NULL,
	"source" text NOT NULL,
	"saved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment_blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"material_key" text NOT NULL,
	"selection" jsonb NOT NULL,
	"rendered_text" text,
	"blob_sha256" text,
	"document_title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"exam_id" uuid,
	"exam_session_id" uuid,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"candidate_no" text NOT NULL,
	"pin_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subquestion_key" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"case_key" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exam_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"token_budget" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"package_sha256" text NOT NULL,
	"definition" jsonb NOT NULL,
	"grading" jsonb NOT NULL,
	"rubrics" jsonb NOT NULL,
	"answer_keys" jsonb NOT NULL,
	"material_files" jsonb NOT NULL,
	"imported_by" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "exams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "grade_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grading_job_id" uuid NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"case_key" text NOT NULL,
	"axis" text NOT NULL,
	"item_id" text NOT NULL,
	"item_kind" text NOT NULL,
	"description" text NOT NULL,
	"points" double precision NOT NULL,
	"earned" double precision,
	"status" text NOT NULL,
	"grader" text NOT NULL,
	"detail" jsonb NOT NULL,
	"rubric_version" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grading_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"status" text NOT NULL,
	"llm_mode" text NOT NULL,
	"llm_provider" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"batch_id" text,
	"batch_requests" jsonb,
	"error" text,
	"progress" jsonb
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"subquestion_key" text,
	"client_message_id" text,
	"content" jsonb NOT NULL,
	"plain_text" text NOT NULL,
	"charged_tokens" integer,
	"context_tokens" integer,
	"pattern_hits" jsonb,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"stop_reason" text,
	"usage" jsonb,
	"latency_ms" integer,
	"provider_request_id" text,
	"provider_message_id" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grading_job_id" uuid NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"status" text NOT NULL,
	"total" double precision,
	"axis_percent" jsonb NOT NULL,
	"violation_count" integer NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"message_id" uuid,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grading_job_id" uuid NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"message_id" uuid,
	"source" text NOT NULL,
	"tag" text NOT NULL,
	"label" text NOT NULL,
	"count" integer NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_blob_sha256_attachment_blobs_sha256_fk" FOREIGN KEY ("blob_sha256") REFERENCES "public"."attachment_blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_events" ADD CONSTRAINT "client_events_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_imported_by_admins_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_grading_job_id_grading_jobs_id_fk" FOREIGN KEY ("grading_job_id") REFERENCES "public"."grading_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_jobs" ADD CONSTRAINT "grading_jobs_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_jobs" ADD CONSTRAINT "grading_jobs_requested_by_admins_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_scores" ADD CONSTRAINT "session_scores_grading_job_id_grading_jobs_id_fk" FOREIGN KEY ("grading_job_id") REFERENCES "public"."grading_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_scores" ADD CONSTRAINT "session_scores_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_grading_job_id_grading_jobs_id_fk" FOREIGN KEY ("grading_job_id") REFERENCES "public"."grading_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_exam_session_id_exam_sessions_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answers_version_uq" ON "answers" USING btree ("exam_session_id","subquestion_key","version");--> statement-breakpoint
CREATE INDEX "attachments_session_idx" ON "attachments" USING btree ("exam_session_id");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "audit_events_session_idx" ON "audit_events" USING btree ("exam_session_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_exam_idx" ON "audit_events" USING btree ("exam_id","id");--> statement-breakpoint
CREATE INDEX "auth_sessions_principal_idx" ON "auth_sessions" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_candidate_no_uq" ON "candidates" USING btree ("candidate_no");--> statement-breakpoint
CREATE INDEX "candidates_exam_idx" ON "candidates" USING btree ("exam_id");--> statement-breakpoint
CREATE INDEX "client_events_session_idx" ON "client_events" USING btree ("exam_session_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_seq_uq" ON "conversations" USING btree ("exam_session_id","case_key","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_sessions_candidate_uq" ON "exam_sessions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "exam_sessions_exam_idx" ON "exam_sessions" USING btree ("exam_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "grade_items_uq" ON "grade_items" USING btree ("grading_job_id","exam_session_id","case_key","item_id");--> statement-breakpoint
CREATE INDEX "grade_items_session_idx" ON "grade_items" USING btree ("exam_session_id");--> statement-breakpoint
CREATE INDEX "grading_jobs_status_idx" ON "grading_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_seq_uq" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_uq" ON "messages" USING btree ("conversation_id","client_message_id");--> statement-breakpoint
CREATE INDEX "messages_session_idx" ON "messages" USING btree ("exam_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_scores_uq" ON "session_scores" USING btree ("grading_job_id","exam_session_id");--> statement-breakpoint
CREATE INDEX "token_ledger_session_idx" ON "token_ledger" USING btree ("exam_session_id","id");--> statement-breakpoint
CREATE INDEX "violations_session_idx" ON "violations" USING btree ("exam_session_id");