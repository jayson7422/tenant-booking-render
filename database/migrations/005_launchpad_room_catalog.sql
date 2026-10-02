-- Add the current Launchpad room catalog to the Tenant booking database.
-- Existing rooms are preserved; each insert is safe to run once through the
-- migration runner and guarded by the company/name unique key.

INSERT INTO rooms (id, company_id, name, location, capacity, calendar_id)
SELECT 'r-apollo-45', 'company-main', 'Apollo 4 & 5', 'Launchpad Coworking (LP1)', 0,
       'c_92b7fc082c6b176ae24e2cc68b1a21b3e9ef1d4fbf13b03e973694107688f9b5@group.calendar.google.com'
WHERE EXISTS (SELECT 1 FROM companies WHERE id = 'company-main')
  AND NOT EXISTS (SELECT 1 FROM rooms WHERE company_id = 'company-main' AND name = 'Apollo 4 & 5');

INSERT INTO rooms (id, company_id, name, location, capacity, calendar_id)
SELECT 'r-meeting-1', 'company-main', 'Meeting Room 1', 'LPOG (One Griffinstone)', 15,
       'c_798733cb01778ce377181b04f298e999882d39623e5511c430658ae57c64ab3d@group.calendar.google.com'
WHERE EXISTS (SELECT 1 FROM companies WHERE id = 'company-main')
  AND NOT EXISTS (SELECT 1 FROM rooms WHERE company_id = 'company-main' AND name = 'Meeting Room 1');

INSERT INTO rooms (id, company_id, name, location, capacity, calendar_id)
SELECT 'r-meeting-2', 'company-main', 'Meeting Room 2', 'LPOG (One Griffinstone)', 8,
       'c_8211b03b94e36d2fb3d6da09e44f915d64a66016426c3b8507c2d1547faeeb26@group.calendar.google.com'
WHERE EXISTS (SELECT 1 FROM companies WHERE id = 'company-main')
  AND NOT EXISTS (SELECT 1 FROM rooms WHERE company_id = 'company-main' AND name = 'Meeting Room 2');

INSERT INTO rooms (id, company_id, name, location, capacity, calendar_id)
SELECT 'r-astra-combined', 'company-main', 'Combined Astra 1 & 2', 'Launchpad Suite ( LP3 )', 16,
       'c_fe21e870471ad9f1399ce1ccfd46d5deb0698fde672cb2109102bc9f952c7ee1@group.calendar.google.com,c_748ea32c6e6df73af2a4bb8a06b6e43b79ed8d4bf66435b29428a6f20a01703d@group.calendar.google.com'
WHERE EXISTS (SELECT 1 FROM companies WHERE id = 'company-main')
  AND NOT EXISTS (SELECT 1 FROM rooms WHERE company_id = 'company-main' AND name = 'Combined Astra 1 & 2');

INSERT INTO rooms (id, company_id, name, location, capacity, calendar_id)
SELECT 'r-meeting-combined', 'company-main', 'Combined Meeting Room 1 & 2', 'LPOG (One Griffinstone)', 23,
       'c_798733cb01778ce377181b04f298e999882d39623e5511c430658ae57c64ab3d@group.calendar.google.com,c_8211b03b94e36d2fb3d6da09e44f915d64a66016426c3b8507c2d1547faeeb26@group.calendar.google.com'
WHERE EXISTS (SELECT 1 FROM companies WHERE id = 'company-main')
  AND NOT EXISTS (SELECT 1 FROM rooms WHERE company_id = 'company-main' AND name = 'Combined Meeting Room 1 & 2');

INSERT INTO schema_migrations (version, description)
VALUES ('005', 'Launchpad room catalog')
ON DUPLICATE KEY UPDATE description = VALUES(description);
