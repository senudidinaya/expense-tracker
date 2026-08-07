CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"month_start" date NOT NULL,
	"amount_minor" bigint,
	"currency" char(3) DEFAULT 'LKR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_month_start_check" CHECK (extract(day from "budgets"."month_start") = 1),
	CONSTRAINT "budgets_amount_minor_check" CHECK ("budgets"."amount_minor" is null or "budgets"."amount_minor" >= 0),
	CONSTRAINT "budgets_currency_check" CHECK ("budgets"."currency" = 'LKR')
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_name_length_check" CHECK (char_length("categories"."name") between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"recurring_rule_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'LKR' NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_minor_check" CHECK ("expenses"."amount_minor" > 0),
	CONSTRAINT "expenses_currency_check" CHECK ("expenses"."currency" = 'LKR'),
	CONSTRAINT "expenses_description_length_check" CHECK (char_length("expenses"."description") between 1 and 200),
	CONSTRAINT "expenses_notes_length_check" CHECK ("expenses"."notes" is null or char_length("expenses"."notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "recurring_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'LKR' NOT NULL,
	"description" text NOT NULL,
	"notes" text,
	"frequency" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"next_occurrence" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_rules_amount_minor_check" CHECK ("recurring_rules"."amount_minor" > 0),
	CONSTRAINT "recurring_rules_currency_check" CHECK ("recurring_rules"."currency" = 'LKR'),
	CONSTRAINT "recurring_rules_description_length_check" CHECK (char_length("recurring_rules"."description") between 1 and 200),
	CONSTRAINT "recurring_rules_notes_length_check" CHECK ("recurring_rules"."notes" is null or char_length("recurring_rules"."notes") <= 2000),
	CONSTRAINT "recurring_rules_frequency_check" CHECK ("recurring_rules"."frequency" in ('weekly', 'monthly')),
	CONSTRAINT "recurring_rules_end_date_check" CHECK ("recurring_rules"."end_date" is null or "recurring_rules"."end_date" >= "recurring_rules"."start_date")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" citext NOT NULL,
	"password_hash" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurring_rule_id_recurring_rules_id_fk" FOREIGN KEY ("recurring_rule_id") REFERENCES "recurring_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_user_cat_month_uq" ON "budgets" USING btree ("user_id","category_id","month_start");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_user_name_active_uq" ON "categories" USING btree ("user_id",lower("name")) WHERE "categories"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "expenses_user_date_idx" ON "expenses" USING btree ("user_id","date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expenses_user_cat_date_idx" ON "expenses" USING btree ("user_id","category_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_rule_date_uq" ON "expenses" USING btree ("recurring_rule_id","date") WHERE "expenses"."recurring_rule_id" is not null;--> statement-breakpoint
CREATE INDEX "recurring_rules_user_idx" ON "recurring_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recurring_rules_due_idx" ON "recurring_rules" USING btree ("next_occurrence");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");