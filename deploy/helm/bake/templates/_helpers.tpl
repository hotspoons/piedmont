{{- define "piedmont-bake.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "piedmont-bake.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains .Chart.Name .Release.Name }}{{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}{{ printf "%s-%s" .Release.Name (include "piedmont-bake.name" .) | trunc 63 | trimSuffix "-" }}{{ end -}}
{{- end -}}
{{- define "piedmont-bake.labels" -}}
app.kubernetes.io/name: {{ include "piedmont-bake.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "piedmont-bake.claimName" -}}
{{- if .Values.data.existingClaim }}{{ .Values.data.existingClaim }}{{ else }}{{ include "piedmont-bake.fullname" . }}-data{{ end -}}
{{- end -}}
