CREATE TABLE "entry_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"plan_entry_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"swapped_for" text,
	"rating" smallint,
	"note" text,
	"took_longer" boolean DEFAULT false NOT NULL,
	"portion_issue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_feedback_outcome_known" CHECK ("entry_feedback"."outcome" in ('cooked', 'skipped', 'swapped')),
	CONSTRAINT "entry_feedback_portion_known" CHECK ("entry_feedback"."portion_issue" is null or "entry_feedback"."portion_issue" in ('too_much', 'too_little')),
	CONSTRAINT "entry_feedback_rating_range" CHECK ("entry_feedback"."rating" is null or "entry_feedback"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "entry_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entry_feedback" ADD CONSTRAINT "entry_feedback_plan_entry_id_plan_entry_id_fk" FOREIGN KEY ("plan_entry_id") REFERENCES "public"."plan_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entry_feedback_entry_key" ON "entry_feedback" USING btree ("plan_entry_id");--> statement-breakpoint
CREATE INDEX "entry_feedback_user_idx" ON "entry_feedback" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "entry_feedback_owner" ON "entry_feedback" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("entry_feedback"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("entry_feedback"."user_id" = nullif(current_setting('app.user_id', true), ''));