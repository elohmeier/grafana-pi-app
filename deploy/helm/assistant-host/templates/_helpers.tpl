{{- define "assistant-host.name" -}}{{ .Release.Name }}-assistant-host{{- end -}}
{{- define "assistant-host.labels" -}}
app.kubernetes.io/name: assistant-host
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "assistant-host.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      optional: {{ .optional }}
{{- end -}}
