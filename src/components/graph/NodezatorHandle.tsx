import React from 'react';
import { Handle, type HandleProps } from '@xyflow/react';

export const NodezatorHandle: React.FC<HandleProps> = (props) => {
  return (
    <Handle
      {...props}
      className={`nodezator-interactive-handle ${props.className || ''}`}
    />
  );
};