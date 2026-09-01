CREATE TABLE "prep_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"source_entry_id" uuid,
	"dependent_entry_id" uuid NOT NULL,
	"servings_drawn" smallint DEFAULT 1 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_link_servings_positive" CHECK ("prep_link"."servings_drawn" > 0),
	CONSTRAINT "prep_link_not_self" CHECK ("prep_link"."source_entry_id" is null or "prep_link"."source_entry_id" <> "prep_link"."dependent_entry_id")
);
--> statement-breakpoint
ALTER TABLE "prep_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prep_link" ADD CONSTRAINT "prep_link_source_entry_id_plan_entry_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "public"."plan_entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_link" ADD CONSTRAINT "prep_link_dependent_entry_id_plan_entry_id_fk" FOREIGN KEY ("dependent_entry_id") REFERENCES "public"."plan_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prep_link_dependent_key" ON "prep_link" USING btree ("dependent_entry_id");--> statement-breakpoint
CREATE INDEX "prep_link_source_idx" ON "prep_link" USING btree ("source_entry_id");--> statement-breakpoint
CREATE POLICY "prep_link_owner" ON "prep_link" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("prep_link"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("prep_link"."user_id" = nullif(current_setting('app.user_id', true), ''));