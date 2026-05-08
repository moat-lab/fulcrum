ALTER TABLE `system_metrics` ADD `host_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `hosts` ADD `password` text;
