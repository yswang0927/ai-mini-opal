const TEMPLATE_REGEX = /\{\{"type":"in","path":"([^"]+)","title":"([^"]+)"\}\}/g;

export function resolvePromptTemplate(
  template: string,
  nodeOutputs: Record<string, string>
): string {
  console.log('>> nodeOutputs: ', nodeOutputs);
  const resolved = template.replace(TEMPLATE_REGEX, (_match, path: string, _title: string) => {
    return nodeOutputs[path] ?? `[未获取到: ${path}]`;
  });
  console.log('>> resolved template: ', resolved);
  return resolved;
}
