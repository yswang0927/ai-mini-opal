const TEMPLATE_REGEX = /\{\{(.*?)\}\}/g;

export function resolvePromptTemplate(
  template: string,
  nodeOutputs: Record<string, string>
): string {
  console.log('>> nodeOutputs: \n', nodeOutputs);
  const resolved = template.replace(TEMPLATE_REGEX, (match, inner: string) => {
    try {
      const obj = JSON.parse(`{${inner}}`);
      if (obj.type === 'in' && obj.path) {
        return nodeOutputs[obj.path] ?? `[未获取到: ${obj.path}]`;
      }
    } catch {}
    return match;
  });
  console.log('>> resolvedPromptTemplate: \n', resolved);
  return resolved;
}
