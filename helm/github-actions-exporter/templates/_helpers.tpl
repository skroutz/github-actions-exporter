{{/* Expand the chart name. */}}
{{- define "github-actions-exporter.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Create a release-scoped resource name. */}}
{{- define "github-actions-exporter.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "github-actions-exporter.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/* Standard Kubernetes labels. */}}
{{- define "github-actions-exporter.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "github-actions-exporter.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Labels used by the Deployment selector and Service. */}}
{{- define "github-actions-exporter.selectorLabels" -}}
app.kubernetes.io/name: {{ include "github-actions-exporter.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Secret name, either supplied or release-scoped. */}}
{{- define "github-actions-exporter.secretName" -}}
{{- default (include "github-actions-exporter.fullname" .) .Values.secret.existingSecret }}
{{- end }}

{{/* Service account name. */}}
{{- define "github-actions-exporter.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "github-actions-exporter.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
