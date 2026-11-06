export interface ModelRequirement {
  key: string
  name: string
  directory: string
  url: string | null
  sha256: string | null
  installed: boolean
  installed_path: string | null
  size_bytes: number | null
}

export interface TemplateSummary {
  id: string
  title: string
  description: string
  category: string
  media_type: string
  media_subtype: string
  tags: string[]
  model_families: string[]
  open_source: boolean
  estimated_size_bytes: number
  usage: number
  date: string
  status: 'ready' | 'needs_models' | 'needs_nodes' | 'paid_api'
  installed: boolean
  favorite: boolean
  models: ModelRequirement[]
  missing_models: string[]
  missing_nodes: string[]
  required_nodes: string[]
  has_subgraphs: boolean
  io_inputs: Array<{ nodeId: number; nodeType: string; file: string; mediaType: string }>
  io_outputs: Array<{ nodeId: number; nodeType: string; file: string; mediaType: string }>
  thumbnail_url: string | null
  tutorial_url: string | null
  source_sha256: string
}

export interface ExtractedParameter {
  key: string
  node_id: string
  node_class: string
  node_title: string
  input_name: string
  label: string
  group: 'primary' | 'details'
  category: 'prompt' | 'negative_prompt' | 'media' | 'dimensions' | 'sampling' | 'advanced' | 'model'
  param_type: 'string' | 'multiline' | 'int' | 'float' | 'boolean' | 'combo' | 'image' | 'audio' | 'video'
  default: any
  required: boolean
  min: number | null
  max: number | null
  step: number | null
  options: any[]
  tooltip: string | null
}

export interface DownloadJob {
  id: string
  template_id: string
  model_key: string
  filename: string
  directory: string
  url: string
  target_path: string
  status: 'queued' | 'downloading' | 'installed' | 'failed' | 'cancelled'
  bytes_downloaded: number
  total_bytes: number | null
  speed_bps: number
  error: string | null
}

export interface RunOutput {
  node_id: string
  filename: string
  subfolder: string
  type: string
  media_kind: 'image' | 'video' | 'audio' | '3d'
  url: string
}

export interface RunRecord {
  id: string
  template_id: string
  template_title: string
  prompt_id: string | null
  status: 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress_step: number
  progress_total: number
  current_node: string | null
  fields: Record<string, any>
  outputs: RunOutput[]
  error: string | null
  created_at: number
  completed_at: number | null
}

export interface TemplateDetailResponse {
  template: TemplateSummary
  installed_record: any | null
  parameters: ExtractedParameter[]
  primary_parameters: ExtractedParameter[]
  detail_parameters: ExtractedParameter[]
  disk: { total_bytes: number; used_bytes: number; free_bytes: number }
  downloads: DownloadJob[]
  compiled_prompt: Record<string, any>
  editor_workflow: Record<string, any>
}

export interface SettingsInfo {
  studio_host: string
  studio_port: number
  comfyui_url: string
  default_comfyui_url: string
  is_custom_comfyui_url: boolean
  default_segment_seconds: number
  models_root: string
  data_dir: string
  has_hf_token: boolean
  hf_token_masked: string
  has_civitai_token: boolean
  civitai_token_masked: string
}

export interface UpdateSettingsPayload {
  hf_token?: string
  civitai_token?: string
  comfyui_url?: string
  default_segment_seconds?: number
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`
}
