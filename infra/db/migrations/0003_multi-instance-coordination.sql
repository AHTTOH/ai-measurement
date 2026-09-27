CREATE TABLE "ai_streams" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"snapshot" text,
	"terminal" jsonb,
	"reserved_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limit_hits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_streams" ADD CONSTRAINT "ai_streams_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limit_hits_bucket_at_idx" ON "rate_limit_hits" USING btree ("bucket","at");