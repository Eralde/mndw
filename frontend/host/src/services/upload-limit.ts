import {MAX_UPLOAD_BYTES} from '../constants.js';
export function getUploadLimitLabel(
  hostT: (key: string, values?: Record<string, unknown>) => string,
): string {
  const megabytes = MAX_UPLOAD_BYTES / (1024 * 1024);

  return `${megabytes} ${hostT('settings.plugin-manager.upload-limit-unit')}`;
}
