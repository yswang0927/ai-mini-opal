import { useState, useEffect, useRef } from 'react';
import Quill from 'quill';
import { useEditorContext } from './EditorContext';
import { NodeTypes, type NodeData, type NodeTypeKey } from '@/components/graph/OpalNodes';

import "quill/dist/quill.core.css";

// 步骤节点详情
const StepDetail = ({stepData}: {
    stepData: NodeData
}) => {
    console.log('>> stepData: ', stepData);
    const quillDomRef = useRef(null);
    const quillRef = useRef<Quill>(null);

    const typeName = stepData.type as NodeTypeKey;
    const nodeType = NodeTypes[typeName];
    const rawData = stepData.data;

    let desc = '';
    if ('userInput' === typeName) {
        desc = rawData.configuration?.description?.parts[0].text || '';
    }
    else if ('opalGenerate' === typeName) {
        desc = rawData.configuration?.config$prompt?.parts[0].text || rawData.metadata.step_intent || '';
    }
    else if ('opalOutput' === typeName) {
        desc = rawData.configuration?.text?.parts[0].text || rawData.metadata.step_intent || '';
    }

    useEffect(() => {
        const quill = quillRef.current = new Quill(quillDomRef.current!, {
            placeholder: 'Type your prompt here. Use @ to include other content.',
            modules: {
                toolbar: false
            }
        });
    }, []);

    if (quillRef.current) {
        quillRef.current.setText(desc);
    }

    return (
        <div className="flex h-full flex-col opal-node-detail">
            <div className="flex items-center opal-node-detail-header" 
                data-nodetype={stepData.type} 
                style={{ gap: '8px', backgroundColor: nodeType.bgColor}}>
                <span style={{lineHeight:"1"}}>{ nodeType?.icon }</span> 
                <div>{stepData.data.metadata.title}</div>
            </div>
            <div className="relative flex-1 opal-node-detail-body">
                <div className="absolute inset-0"><div ref={quillDomRef}></div></div>
            </div>
        </div>
    );
};

export default function Sidebar() {
    const [selectedTab, setSelectedTab] = useState('');
    const { selectedNode } = useEditorContext();

    useEffect(() => {
        setSelectedTab(selectedNode !== null ? 'Step' : '');
    }, [selectedNode]);

    return (
        <div className="editor-side">
            <div className="editor-side-header">
                <div className="editor-side-nav">
                    <button className={selectedTab === 'Preview' ? 'selected' : ''} onClick={() => setSelectedTab('Preview')}>Preview</button>
                    <button className={selectedTab === 'Console' ? 'selected' : ''} onClick={() => setSelectedTab('Console')}>Console</button>
                    <button className={selectedTab === 'Step' ? 'selected' : ''} onClick={() => setSelectedTab('Step')}>Step</button>
                    <button className={selectedTab === 'Theme' ? 'selected' : ''} onClick={() => setSelectedTab('Theme')}>Theme</button>
                </div>
            </div>

            <div className="editor-side-body">
                {!selectedNode && (<div className="empty-state">Your app will appear here once it's built</div>)}
                { selectedNode && (<StepDetail stepData={selectedNode} />)}
            </div>
        </div>
    );
}