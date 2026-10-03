-- Restricted SQL fixture: an ITSM database with incidents and changes that
-- follow the Prometheus demo incident (report-renderer on vm-web-01 after the
-- CHG-4711 rollout of 3.8.0, rolled back by CHG-4712).
--
-- Sensitive string columns (descriptions, summaries, people) carry sentinel
-- values (PI-SENTINEL-SQL-...); the visible string columns of the plugin policy
-- carry none. dbo.Employees is readable by the grafana login but not in the
-- policy. Run by seed.sh with sqlcmd variables IncidentStart and HistoryEnd
-- (Unix seconds) and GrafanaPassword.
:on error exit
SET NOCOUNT ON;

IF DB_ID(N'itsm') IS NOT NULL
BEGIN
  ALTER DATABASE itsm SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE itsm;
END
GO
CREATE DATABASE itsm;
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'grafana')
  CREATE LOGIN grafana WITH PASSWORD = N'$(GrafanaPassword)', CHECK_POLICY = OFF;
ELSE
  ALTER LOGIN grafana WITH PASSWORD = N'$(GrafanaPassword)', CHECK_POLICY = OFF;
GO
USE itsm;
GO
-- The credential reads every table; the plugin policy is narrower.
CREATE USER grafana FOR LOGIN grafana;
ALTER ROLE db_datareader ADD MEMBER grafana;
GO

CREATE TABLE dbo.Incidents (
  Id int IDENTITY PRIMARY KEY,
  Number nvarchar(16) NULL,
  OpenedAt datetime2(0) NOT NULL,
  ResolvedAt datetime2(0) NULL,
  Priority tinyint NOT NULL,
  State nvarchar(20) NOT NULL,
  Service nvarchar(64) NOT NULL,
  Host nvarchar(64) NOT NULL,
  Category nvarchar(32) NOT NULL,
  AssignmentGroup nvarchar(64) NOT NULL,
  ShortDescription nvarchar(200) NOT NULL,
  Description nvarchar(max) NOT NULL,
  CallerEmail nvarchar(128) NOT NULL
);

CREATE TABLE dbo.Changes (
  Id int IDENTITY PRIMARY KEY,
  Number nvarchar(16) NOT NULL,
  Type nvarchar(16) NOT NULL,
  State nvarchar(20) NOT NULL,
  Service nvarchar(64) NOT NULL,
  Host nvarchar(64) NOT NULL,
  Version nvarchar(16) NOT NULL,
  PlannedStart datetime2(0) NOT NULL,
  ImplementedAt datetime2(0) NULL,
  Summary nvarchar(400) NOT NULL,
  Implementer nvarchar(128) NOT NULL
);

CREATE TABLE dbo.Employees (
  Id int IDENTITY PRIMARY KEY,
  Name nvarchar(128) NOT NULL,
  Department nvarchar(64) NOT NULL,
  Salary decimal(10, 2) NOT NULL
);
GO

DECLARE @incidentStart datetime2(0) = DATEADD(SECOND, $(IncidentStart), '19700101');
DECLARE @end datetime2(0) = DATEADD(SECOND, $(HistoryEnd), '19700101');

WITH numbers AS (
  SELECT TOP (1440) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS i
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
),
background AS (
  SELECT
    i,
    DATEADD(MINUTE, -(i * 30 + ABS(CHECKSUM(i, 1)) % 30), DATEADD(HOUR, -1, @incidentStart)) AS OpenedAt,
    ABS(CHECKSUM(i, 2)) % 6 AS s,
    ABS(CHECKSUM(i, 3)) AS r
  FROM numbers
)
INSERT dbo.Incidents
  (OpenedAt, ResolvedAt, Priority, State, Service, Host, Category, AssignmentGroup, ShortDescription, Description, CallerEmail)
SELECT
  OpenedAt,
  CASE WHEN i < 48 AND r % 3 = 0 THEN NULL ELSE DATEADD(MINUTE, 30 + r % 600, OpenedAt) END,
  CHOOSE(r % 10 + 1, 4, 4, 4, 3, 3, 3, 3, 2, 2, 1),
  CASE WHEN i < 48 AND r % 3 = 0 THEN CHOOSE(r % 2 + 1, N'New', N'In Progress') WHEN i < 336 THEN N'Resolved' ELSE N'Closed' END,
  CHOOSE(s + 1, N'catalog', N'checkout', N'search', N'payments', N'identity', N'report-renderer'),
  CASE WHEN s = 5 THEN CONCAT(N'vm-web-0', 1 + r % 2)
    ELSE CONCAT(CHOOSE(s + 1, N'catalog', N'checkout', N'search', N'payments', N'identity'), N'-', 1 + r % 3) END,
  CHOOSE(r % 5 + 1, N'Software', N'Hardware', N'Network', N'Access', N'Database'),
  CHOOSE(s + 1, N'Shop Team', N'Shop Team', N'Search Team', N'Payments Team', N'Identity Team', N'Reporting Ops'),
  CONCAT(N'PI-SENTINEL-SQL-INC-', i, N' ',
    CHOOSE(r % 4 + 1, N'Page loads slowly for customer Miller', N'Login fails with password reset loop',
      N'Order stuck after payment of invoice 2291', N'Export shows wrong totals')),
  CONCAT(N'PI-SENTINEL-SQL-DESC-', i, N' Caller reports the problem on account ', 100000 + r % 900000,
    N'. Steps to reproduce attached.'),
  CONCAT(N'pi-sentinel-sql-caller-', i, N'@example.com')
FROM background;

-- The incident: report downloads fail on vm-web-01 after the 3.8.0 rollout.
WITH burst AS (
  SELECT TOP (24) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS k FROM sys.all_objects
)
INSERT dbo.Incidents
  (OpenedAt, ResolvedAt, Priority, State, Service, Host, Category, AssignmentGroup, ShortDescription, Description, CallerEmail)
SELECT
  DATEADD(SECOND, 180 + k * 25, @incidentStart),
  NULL,
  CASE WHEN k = 5 THEN 1 ELSE 2 END,
  CASE WHEN k % 3 = 0 THEN N'In Progress' ELSE N'New' END,
  N'report-renderer',
  N'vm-web-01',
  N'Software',
  N'Reporting Ops',
  CONCAT(N'PI-SENTINEL-SQL-RR-', k, N' Report download fails with timeout for customer ', 4000 + k),
  CONCAT(N'PI-SENTINEL-SQL-RR-DESC-', k, N' Quarterly report for account ', 70000 + k * 13, N' times out after 30 s.'),
  CONCAT(N'pi-sentinel-sql-rr-', k, N'@example.com')
FROM burst;

WITH ordered AS (SELECT Number, ROW_NUMBER() OVER (ORDER BY OpenedAt, Id) AS n FROM dbo.Incidents)
UPDATE ordered SET Number = CONCAT(N'INC', 100000 + n);

WITH numbers AS (
  SELECT TOP (60) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS i FROM sys.all_objects
),
background AS (
  SELECT
    i,
    DATEADD(MINUTE, -(i * 720 + ABS(CHECKSUM(i, 4)) % 240), DATEADD(HOUR, -2, @incidentStart)) AS PlannedStart,
    ABS(CHECKSUM(i, 5)) % 5 AS s,
    ABS(CHECKSUM(i, 6)) AS r
  FROM numbers
)
INSERT dbo.Changes (Number, Type, State, Service, Host, Version, PlannedStart, ImplementedAt, Summary, Implementer)
SELECT
  CONCAT(N'CHG-', 4700 - i),
  CHOOSE(r % 3 + 1, N'Standard', N'Normal', N'Emergency'),
  N'Closed',
  CHOOSE(s + 1, N'catalog', N'checkout', N'search', N'payments', N'identity'),
  CONCAT(CHOOSE(s + 1, N'catalog', N'checkout', N'search', N'payments', N'identity'), N'-', 1 + r % 3),
  CONCAT(1 + r % 9, N'.', r % 20, N'.', r % 7),
  PlannedStart,
  DATEADD(MINUTE, 5 + r % 50, PlannedStart),
  CONCAT(N'PI-SENTINEL-SQL-CHG-', i, N' Rollout approved by CAB, contact on-call ', 1000 + r % 9000),
  CONCAT(N'pi-sentinel-sql-implementer-', i, N'@example.com')
FROM background;

INSERT dbo.Changes (Number, Type, State, Service, Host, Version, PlannedStart, ImplementedAt, Summary, Implementer)
VALUES
  (N'CHG-4711', N'Normal', N'Implemented', N'report-renderer', N'vm-web-01', N'3.8.0',
    DATEADD(SECOND, 60, @incidentStart), DATEADD(SECOND, 155, @incidentStart),
    N'PI-SENTINEL-SQL-CHG-4711 Rollout of new PDF engine, contact Jane Doe', N'pi-sentinel-sql-jane.doe@example.com'),
  (N'CHG-4712', N'Emergency', N'Implemented', N'report-renderer', N'vm-web-01', N'3.7.2',
    DATEADD(SECOND, 780, @incidentStart), DATEADD(SECOND, 875, @incidentStart),
    N'PI-SENTINEL-SQL-CHG-4712 Rollback after report timeouts', N'pi-sentinel-sql-john.roe@example.com');

INSERT dbo.Employees (Name, Department, Salary)
SELECT TOP (20)
  CONCAT(N'PI-SENTINEL-SQL-EMP-', ROW_NUMBER() OVER (ORDER BY (SELECT NULL))),
  N'Operations',
  50000 + ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) * 1234.5
FROM sys.all_objects;
GO
