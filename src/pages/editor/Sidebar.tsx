import React, {useCallback, useEffect, useRef, useState} from 'react';
import {useReactFlow} from '@xyflow/react';
import Quill from 'quill';
import {Mention, MentionBlot} from "quill-mention";
import type {NodeExecInfo} from '@/components/graph/executor';
import {ExecutorPanel} from '@/components/graph/executor';
import {NodeTypesStyle} from '@/components/graph/types';
import {type OpalJson, type OpalNode, OpalNodeType} from '@/types';
import {useL10n} from "@/l10n";
import {debounce} from '@/utils';

import {useEditorContext} from './EditorContext';
import {
  OPAL_TAG_ICONS,
  OpalRefTagBlot,
  OpalRefTagMentionBlot,
  OpalRefTagModule,
  type OpalTagType,
  quillContentToText,
} from './QuillCustomBlots';

import "quill/dist/quill.core.css";
import "quill-mention/dist/quill.mention.css";


Quill.register('blots/opalRefTag', OpalRefTagBlot);
Quill.register('modules/opalRefTag', OpalRefTagModule);
Quill.register({ "blots/mention": MentionBlot, "modules/mention": Mention });
Quill.register(OpalRefTagMentionBlot);


const ASSET_TYPES = new Set<string>([OpalNodeType.AssetsText, OpalNodeType.AssetsFile]);

// 内容编辑器组件
const QuillEditor = ({stepData, opalData, onEditorChange}: {
  stepData: OpalNode;
  opalData: OpalJson | null;
  onEditorChange: (text:string) => void;
}) => {
  const { t } = useL10n();
  const quillDomRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);

  const typeName = stepData.type;
  const isAssetType: boolean = ASSET_TYPES.has(typeName);

  useEffect(() => {
    if (!quillDomRef.current || quillRef.current) return;

    const quill = quillRef.current = new Quill(quillDomRef.current, {
      placeholder: isAssetType ? t('在此输入您的提示') : t('在此输入您的提示。使用 @ 来包含其他内容。'),
      theme: 'snow',
      modules: isAssetType ? {toolbar: false} : {
        toolbar: false,
        // 激活我们的自定义模块
        opalRefTag: true,
        mention: {
          allowedChars: /^.*$/,
          mentionDenotationChars: ["@"],
          dataAttributes: ['id', 'value', 'refType', 'path'],
          blotName: "opalRefTagMention",
          source: async function(searchTerm: string, renderList: Function) {
            const steps = (opalData?.nodes || []).filter(item => item.id !== stepData.id);
            const stepsList = steps.map(item => ({
              id: item.id,
              value: item.metadata?.title || item.id,
              team: "Step",
              refType: "in",
              path: item.id
            }));
            // 解析 assets 静态资源节点
            const opalAssets = opalData?.assets || null;
            if (opalAssets) {
              for (const assetId in opalAssets) {
                const assetData = opalAssets[assetId];
                stepsList.push({
                  id: assetId,
                  value: assetData.metadata?.title || assetId,
                  team: "Step",
                  refType: "asset",
                  path: assetId
                });
              }
            }

            const toolsList = [
              {id: 'search-web', value: '搜索网页', team: 'Tool', refType: 'tool', path: 'search-web'},
              {id: 'code-execution', value: '代码执行', team: 'Tool', refType: 'tool', path: 'code-execution'}
            ];

            const allItems = [...toolsList, ...stepsList];
            if (!searchTerm) {
              renderList(allItems);
            } else {
              const filtered = allItems.filter(item =>
                item.value.toLowerCase().includes(searchTerm.toLowerCase())
              );
              renderList(filtered);
            }
          },
          renderItem: function(item: any) {
            const div = document.createElement('div');
            div.className = `opal-mention-item mention-item-type-${item.refType}`;
            div.innerHTML = `<span class="mention-item-icon">${OPAL_TAG_ICONS[item.refType as OpalTagType]}</span><span>${item.value}</span>`;
            return div;
          }
        }
      },
    });

    const handleTextChange = debounce((_delta: any, _oldDelta: any, source: string) => {
      // 只有真正的用户输入才需要保存：
      if (source !== 'user') {
        return;
      }

      const text = quillContentToText(quill);
      onEditorChange(text);
      console.log('quill-text: ', text);
    }, 200);

    quill.on(Quill.events.TEXT_CHANGE, handleTextChange);

    return () => {
      quill.off(Quill.events.TEXT_CHANGE, handleTextChange);
      handleTextChange.cancel();
      quillRef.current = null;
    };
  }, []);

  useEffect(() => {
    const quill = quillRef.current;
    if (!quill) {
      return;
    }

    let content = '';
    if (OpalNodeType.UserInputs === typeName) {
      content = stepData.configuration?.description?.content || '';
    }
    else if (OpalNodeType.AgentGenerate === typeName) {
      content = stepData.configuration?.config$prompt?.content || '';
    }
    else if (OpalNodeType.RenderOutputs === typeName) {
      content = stepData.configuration?.text?.content || '';
    }
    else if (OpalNodeType.AssetsText === typeName) {
      content = stepData.configuration?.text?.content || '';
    }

    quill.setText(content, Quill.sources.API);
    quill.history.clear(); // 避免 Ctrl+Z 撤回到上一个 step 的内容
  }, [stepData]);

  return (
      <div ref={quillDomRef}></div>
  );
};

// 资源文件预览
const AssetFilePreview = ({stepData}:{stepData: OpalNode}) => {
  return (
      <div>File: {stepData.configuration.file?.url}</div>
  );
};

/**
 * 步骤节点数据详情
 * {id, type, metadata, configuration}
 */
const StepDetailView = React.memo(({stepData, opalData, setOpalData}: {
  stepData: OpalNode;
  opalData: OpalJson | null;
  setOpalData: (data: OpalJson | null, silent?: boolean) => void;
}) => {
  console.log('>> stepData: \n', JSON.stringify(stepData));
  const { updateNode } = useReactFlow();

  const [title, setTitle] = useState(stepData.metadata.title);

  const typeName = stepData.type;
  const nodeTypeStyle = NodeTypesStyle[typeName];

  const updateStepData = (newData: OpalNode) => {
    updateNode(newData.id, { data: newData });

    if (opalData) {
      if (ASSET_TYPES.has(newData.type)) {
        const assets = {...opalData.assets};
        assets[newData.id] = newData;
        setOpalData({ ...opalData, assets: assets }, true);
      } else {
        const newNodes = (opalData.nodes || []).map(n => n.id === newData.id ? newData : n);
        setOpalData({ ...opalData, nodes: newNodes }, true);
      }
    }
  };

  const handleTitleChange = () => {
    if (title.trim()) {
      const newData = { ...stepData, metadata: { ...stepData.metadata, title: title } };
      updateStepData(newData);
    }
  };

  const onEditorChange = useCallback((text:string) => {
    let targetKey = '';
    if (OpalNodeType.UserInputs === typeName) {
      targetKey = 'description';
    }
    else if (OpalNodeType.AgentGenerate === typeName) {
      targetKey = 'config$prompt';
    }
    else if (OpalNodeType.RenderOutputs === typeName) {
      targetKey = 'text';
    }
    else if (OpalNodeType.AssetsText === typeName) {
      targetKey = 'text';
    }
    else if (OpalNodeType.AssetsFile === typeName) {
      // 资源文件无法修改
    }

    // 如果匹配到了对应的类型，进行统一的安全赋值
    if (targetKey) {
      const newConfig = { ...stepData.configuration };
      newConfig[targetKey] = { ...(newConfig[targetKey] || {content:"", role:"user"}), content: text };
      updateStepData({ ...stepData, configuration: newConfig });
    }
  }, []);

  return (
    <div className="flex h-full flex-col opal-node-detail">
      <div className="flex items-center gap-md opal-node-detail-header"
           data-nodetype={typeName} style={{ backgroundColor: nodeTypeStyle.bgColor }}>
        <span style={{lineHeight:"1"}}>{ nodeTypeStyle.icon }</span>
        <div className="flex-1">
          <input type="text" className="step-title-input" autoComplete="off" required
             value={title}
             onChange={(e) => setTitle(e.target.value)}
             onKeyDown={(e) => {
               if (e.key === 'Enter') {
                 e.preventDefault();
                 (e.target as HTMLInputElement).blur();
               }
             }}
             onBlur={handleTitleChange}
          />
        </div>
      </div>
      <div className="relative flex-1 opal-node-detail-body">
        <div className="absolute inset-0">
          { (OpalNodeType.AssetsFile === typeName)
              ? <AssetFilePreview stepData={stepData} />
              : <QuillEditor stepData={stepData} opalData={opalData} onEditorChange={onEditorChange} />
          }
        </div>
      </div>
    </div>
  );
});

const ConsoleView = ({ execLog, currentNodeId }: {
  execLog: NodeExecInfo[];
  currentNodeId: string | null;
}) => {
  const { t } = useL10n();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [execLog.length]);

  if (execLog.length === 0 && !currentNodeId) {
    return (
      <div className="empty-state">
        <p>{t('运行预览后，节点执行日志将显示在这里')}</p>
      </div>
    );
  }

  return (
    <div className="console-view" ref={scrollRef}>
      {execLog.map((item, idx) => (
        <div key={`${item.nodeId}-${idx}`} className={`console-item console-item-${item.status}`}>
          <div className="console-item-header">
            <span className="console-item-status" data-status={item.status} />
            <span className="console-item-title">{item.title}</span>
          </div>
          {item.input && (
            <div className="console-item-section">
              <span className="console-item-label">Input</span>
              <pre className="console-item-content">{item.input}</pre>
            </div>
          )}
          {item.output && (
            <div className="console-item-section">
              <span className="console-item-label">Output</span>
              <pre className="console-item-content">{item.output}</pre>
            </div>
          )}
        </div>
      ))}
      {currentNodeId && !execLog.find(l => l.nodeId === currentNodeId) && (
        <div className="console-item console-item-running">
          <div className="console-item-header">
            <span className="console-item-status" data-status="running" />
            <span className="console-item-title">{t('执行中...')}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default function Sidebar() {
  const { t } = useL10n();
  const [selectedTab, setSelectedTab] = useState('');
  const { selectedNode, opalPayload, setOpalData, execState, loadGraph, startExecution, submitInput, resetExecutor } = useEditorContext();
  const opalData = opalPayload.data;

  useEffect(() => {
    setSelectedTab(selectedNode !== null ? 'Step' : '');
  }, [selectedNode]);

  const doRunPreview = useCallback(async () => {
    resetExecutor();
    loadGraph(opalData);
  }, [opalData, loadGraph, resetExecutor]);

  const handlePreviewTab = useCallback(() => {
    setSelectedTab('Preview');
    if (execState.status === 'idle') {
      doRunPreview();
    }
  }, [doRunPreview, execState.status]);

  console.log('>> execState: ', execState);

  return (
    <div className="editor-side">
      <div className="editor-side-header">
        <div className="editor-side-nav">
          <button className={selectedTab === 'Preview' ? 'selected' : ''} onClick={handlePreviewTab}>{t('预览应用')}</button>
          <button className={selectedTab === 'Step' ? 'selected' : ''} onClick={() => setSelectedTab('Step')}>{t('节点')}</button>
          <button className={selectedTab === 'Console' ? 'selected' : ''} onClick={() => setSelectedTab('Console')}>{t('控制台')}</button>
          {/*<button className={selectedTab === 'Theme' ? 'selected' : ''} onClick={() => setSelectedTab('Theme')}>{t('主题')}</button>*/}
        </div>
      </div>

      <div className="relative editor-side-body">
        {selectedTab === 'Preview' && (
          <ExecutorPanel
            execState={execState}
            onSubmitInput={submitInput}
            onStart={startExecution}
            onRestart={doRunPreview}
          />
        )}
        {selectedTab === 'Console' && (
          <ConsoleView
            execLog={execState.nodeExecLog}
            currentNodeId={execState.currentNodeId}
          />
        )}
        {selectedTab === 'Step' && !selectedNode && (
          <div className="empty-state">{t('请选择一个节点编辑')}</div>
        )}
        {selectedTab === 'Step' && selectedNode && (
          <StepDetailView key={selectedNode.id} stepData={selectedNode} opalData={opalData} setOpalData={setOpalData} />
        )}
        {selectedTab !== 'Preview' && selectedTab !== 'Step' && selectedTab !== 'Console' && (
          <div className="empty-state">{t('您的应用在构建完成后将在这里显示')}</div>
        )}
      </div>
    </div>
  );
}