# Skills directory

Custom skills can be stored in two places:

- **Plugin settings** (`jsonData.customSkills`, edited on the plugin's configuration page). Grafana rejects plugin settings larger than 64 KiB (`pluginsettings.jsonDataTooLarge`, Grafana 13.3 and later), and a provisioning file that exceeds the limit stops Grafana from starting. Use them for a few short skills.
- **A skills directory on the Grafana server.** The plugin backend reads it, so its size is not limited by plugin settings. Use it for skills with longer references, and to manage skills as files in Git.

Both kinds work the same in a chat: they are listed in the system prompt, activate by keyword, regex, or `$skill-name`, and are mounted read-only under `/.agents/skills/<name>/`. A skill in the directory replaces a skill of the same name in the plugin settings; bundled skills cannot be replaced. Skills move between the two without changing their identity: both are reported as `custom` with the ID `plugin-config/customSkills/<name>` in the `grafana_plugin_assistant_skill_usage_total` metric.

## Layout

The directory has one directory per skill, in the layout of the bundled skills under `assistant/skills/`:

```text
<skills path>/
  team-runbook/
    SKILL.md
    references/escalation.md
    scripts/error-ratio.promql
```

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: team-runbook
description: Incident workflow of the platform team. Use for incidents, outages, and escalations.
activation:
  keywords: [incident, outage, escalation]
  # regex: "\\bINC-\\d+\\b"
  # explicitOnly: true
# disable-model-invocation: true
---

# Team Runbook

Check the service's error ratio first, then follow `references/escalation.md`.
```

- `name` must match the directory name: lowercase kebab-case, 2–64 characters.
- `description` (up to 1024 characters) tells the model when to use the skill.
- `activation` takes the same keys as in the plugin settings: `keywords`, `regex` (JavaScript syntax), and `explicitOnly`. Without `activation`, the skill activates only with `$skill-name`.
- Other frontmatter keys (such as `license` or `metadata`) are ignored.

Text files below `references/`, `templates/`, `assets/`, and `scripts/` become the skill's resources (`.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.promql`, `.jq`, `.py`, `.sh`, `.jsonnet`, `.libsonnet`, `.css`, `.ts`, `.tsx`). Other files, and files and directories whose names start with a dot, are ignored.

Limits: 100 skills, 64 KiB per `SKILL.md`, 100 resources of up to 256 KiB per skill, and 8 MiB for all skills together. Invalid skills and files are skipped; the plugin's configuration page and Grafana's log name them and the reason.

The directory is read for every chat, so changes apply to the next chat without restarting Grafana.

## Configuration

Set the directory in the plugin's section of `grafana.ini` (with the plugin ID of your build, `g42-pi-app` or `grafana-assistant-app`):

```ini
[plugin.grafana-assistant-app]
skills_path = /var/lib/grafana-assistant/skills
```

Grafana passes the section's keys to the plugin's backend process, so no other setting is needed. The directory must be readable by the Grafana process; with several Grafana replicas, give every replica the same files.

Alternatively, set `PI_SKILLS_PATH` in Grafana's environment. Grafana forwards its environment to the plugin only when the plugin ID is listed in `[plugins] forward_host_env_vars`, so `grafana.ini` is usually simpler.

The plugin's configuration page lists the skills of the directory above the plugin settings' custom skills, with the files it skipped.

## Kubernetes

Keep each skill as files in Git and mount them from a ConfigMap. ConfigMap keys cannot contain `/`, so map the keys to the directory layout with `items`. With the [Grafana Helm chart](https://github.com/grafana/helm-charts/tree/main/charts/grafana):

```yaml
grafana.ini:
  plugin.grafana-assistant-app:
    skills_path: /var/lib/grafana-assistant/skills

extraConfigmapMounts:
  - name: assistant-skills
    configMap: grafana-assistant-skills
    mountPath: /var/lib/grafana-assistant/skills
    readOnly: true
    items:
      - key: team-runbook.SKILL.md
        path: team-runbook/SKILL.md
      - key: team-runbook.escalation.md
        path: team-runbook/references/escalation.md
```

The ConfigMap, for example rendered from the files with Helm's `.Files.Get` or created with `kubectl create configmap grafana-assistant-skills --from-file=team-runbook.SKILL.md=skills/team-runbook/SKILL.md ...`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-assistant-skills
data:
  team-runbook.SKILL.md: |
    ---
    name: team-runbook
    description: Incident workflow of the platform team. Use for incidents, outages, and escalations.
    activation:
      keywords: [incident, outage, escalation]
    ---

    # Team Runbook
    ...
  team-runbook.escalation.md: |
    # Escalation
    ...
```

A ConfigMap holds up to 1 MiB. For more, mount one ConfigMap per skill at `<skills path>/<name>`, with `items` such as `{key: escalation.md, path: references/escalation.md}`. The plugin follows the symlinks of ConfigMap volumes, and Kubernetes updates mounted ConfigMaps (without `subPath`) in place, so changed skills reach the next chat without a Grafana restart.

## Moving skills out of the plugin settings

1. Write each skill of `jsonData.customSkills` as `<name>/SKILL.md`: its `name`, `description`, and `activation` become the frontmatter, its `content` the body, and each resource a file at its `path`.
2. Deploy the directory and `skills_path`. The configuration page marks the plugin-settings skills that the directory now replaces.
3. Remove those skills from `jsonData.customSkills`.

## Local development

The local Grafana containers mount `provisioning/grafana.ini`, which sets `skills_path` to `provisioning/skills`. The sample skill `demo-runbook` there activates with `$demo-runbook`; check it in a chat with `!ls /.agents/skills`.
