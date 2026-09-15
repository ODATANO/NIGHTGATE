import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';
__compactRuntime.checkRuntimeVersion('0.16.0');

const _descriptor_0 = new __compactRuntime.CompactTypeBytes(32);

const _descriptor_1 = new __compactRuntime.CompactTypeUnsignedInteger(18446744073709551615n, 8);

class _ContentAnchor_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_0.alignment());
  }
  fromValue(value_0) {
    return {
      root: _descriptor_0.fromValue(value_0),
      schema: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.root).concat(_descriptor_0.toValue(value_0.schema));
  }
}

const _descriptor_2 = new _ContentAnchor_0();

const _descriptor_3 = __compactRuntime.CompactTypeBoolean;

const _descriptor_4 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

const _descriptor_5 = new __compactRuntime.CompactTypeVector(16, _descriptor_3);

class _Attestation_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment())));
  }
  fromValue(value_0) {
    return {
      payload_hash: _descriptor_0.fromValue(value_0),
      metadata_hash: _descriptor_0.fromValue(value_0),
      owner: _descriptor_0.fromValue(value_0),
      document_id: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.payload_hash).concat(_descriptor_0.toValue(value_0.metadata_hash).concat(_descriptor_0.toValue(value_0.owner).concat(_descriptor_0.toValue(value_0.document_id))));
  }
}

const _descriptor_6 = new _Attestation_0();

class _SlotSpec_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_4.alignment().concat(_descriptor_1.alignment()));
  }
  fromValue(value_0) {
    return {
      field_key: _descriptor_0.fromValue(value_0),
      kind: _descriptor_4.fromValue(value_0),
      scale: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.field_key).concat(_descriptor_4.toValue(value_0.kind).concat(_descriptor_1.toValue(value_0.scale)));
  }
}

const _descriptor_7 = new _SlotSpec_0();

const _descriptor_8 = new __compactRuntime.CompactTypeVector(16, _descriptor_7);

class _SlotOpening_0 {
  alignment() {
    return _descriptor_3.alignment().concat(_descriptor_1.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      present: _descriptor_3.fromValue(value_0),
      uint_value: _descriptor_1.fromValue(value_0),
      value_digest: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_3.toValue(value_0.present).concat(_descriptor_1.toValue(value_0.uint_value).concat(_descriptor_0.toValue(value_0.value_digest)));
  }
}

const _descriptor_9 = new _SlotOpening_0();

const _descriptor_10 = new __compactRuntime.CompactTypeVector(16, _descriptor_9);

const _descriptor_11 = new __compactRuntime.CompactTypeVector(6, _descriptor_3);

const _descriptor_12 = new __compactRuntime.CompactTypeVector(6, _descriptor_0);

const _descriptor_13 = new __compactRuntime.CompactTypeVector(4, _descriptor_0);

const _descriptor_14 = new __compactRuntime.CompactTypeVector(4, _descriptor_3);

const _descriptor_15 = __compactRuntime.CompactTypeField;

class _DocumentDiffClaim_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_4.alignment()))))));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      record_key_a: _descriptor_0.fromValue(value_0),
      content_root_a: _descriptor_0.fromValue(value_0),
      record_key_b: _descriptor_0.fromValue(value_0),
      content_root_b: _descriptor_0.fromValue(value_0),
      schema_id: _descriptor_0.fromValue(value_0),
      k: _descriptor_4.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.record_key_a).concat(_descriptor_0.toValue(value_0.content_root_a).concat(_descriptor_0.toValue(value_0.record_key_b).concat(_descriptor_0.toValue(value_0.content_root_b).concat(_descriptor_0.toValue(value_0.schema_id).concat(_descriptor_4.toValue(value_0.k)))))));
  }
}

const _descriptor_16 = new _DocumentDiffClaim_0();

class _DocumentIntegrityClaim_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_5.alignment()))))));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      record_key_a: _descriptor_0.fromValue(value_0),
      content_root_a: _descriptor_0.fromValue(value_0),
      record_key_b: _descriptor_0.fromValue(value_0),
      content_root_b: _descriptor_0.fromValue(value_0),
      schema_id: _descriptor_0.fromValue(value_0),
      allowed_mask: _descriptor_5.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.record_key_a).concat(_descriptor_0.toValue(value_0.content_root_a).concat(_descriptor_0.toValue(value_0.record_key_b).concat(_descriptor_0.toValue(value_0.content_root_b).concat(_descriptor_0.toValue(value_0.schema_id).concat(_descriptor_5.toValue(value_0.allowed_mask)))))));
  }
}

const _descriptor_17 = new _DocumentIntegrityClaim_0();

class _FieldEqualityClaim_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment())))));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      record_key: _descriptor_0.fromValue(value_0),
      content_root: _descriptor_0.fromValue(value_0),
      schema_id: _descriptor_0.fromValue(value_0),
      field_key: _descriptor_0.fromValue(value_0),
      expected: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.record_key).concat(_descriptor_0.toValue(value_0.content_root).concat(_descriptor_0.toValue(value_0.schema_id).concat(_descriptor_0.toValue(value_0.field_key).concat(_descriptor_0.toValue(value_0.expected))))));
  }
}

const _descriptor_18 = new _FieldEqualityClaim_0();

class _FieldMembershipClaim_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment())))));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      record_key: _descriptor_0.fromValue(value_0),
      content_root: _descriptor_0.fromValue(value_0),
      schema_id: _descriptor_0.fromValue(value_0),
      field_key: _descriptor_0.fromValue(value_0),
      set_root: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.record_key).concat(_descriptor_0.toValue(value_0.content_root).concat(_descriptor_0.toValue(value_0.schema_id).concat(_descriptor_0.toValue(value_0.field_key).concat(_descriptor_0.toValue(value_0.set_root))))));
  }
}

const _descriptor_19 = new _FieldMembershipClaim_0();

class _FieldPredicateClaim_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_1.alignment().concat(_descriptor_4.alignment()))))));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      record_key: _descriptor_0.fromValue(value_0),
      content_root: _descriptor_0.fromValue(value_0),
      schema_id: _descriptor_0.fromValue(value_0),
      field_key: _descriptor_0.fromValue(value_0),
      threshold: _descriptor_1.fromValue(value_0),
      op: _descriptor_4.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.record_key).concat(_descriptor_0.toValue(value_0.content_root).concat(_descriptor_0.toValue(value_0.schema_id).concat(_descriptor_0.toValue(value_0.field_key).concat(_descriptor_1.toValue(value_0.threshold).concat(_descriptor_4.toValue(value_0.op)))))));
  }
}

const _descriptor_20 = new _FieldPredicateClaim_0();

class _SlotSalt_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_4.alignment()));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      seed: _descriptor_0.fromValue(value_0),
      index: _descriptor_4.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.seed).concat(_descriptor_4.toValue(value_0.index)));
  }
}

const _descriptor_21 = new _SlotSalt_0();

class _AttestRecordKey_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      owner: _descriptor_0.fromValue(value_0),
      payload_hash: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.owner).concat(_descriptor_0.toValue(value_0.payload_hash)));
  }
}

const _descriptor_22 = new _AttestRecordKey_0();

class _SetLeaf_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment());
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      value_digest: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.value_digest));
  }
}

const _descriptor_23 = new _SetLeaf_0();

class _SlotDescriptor_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_4.alignment().concat(_descriptor_1.alignment())));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      field_key: _descriptor_0.fromValue(value_0),
      kind: _descriptor_4.fromValue(value_0),
      scale: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.field_key).concat(_descriptor_4.toValue(value_0.kind).concat(_descriptor_1.toValue(value_0.scale))));
  }
}

const _descriptor_24 = new _SlotDescriptor_0();

class _AbsentLeaf_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      field_key: _descriptor_0.fromValue(value_0),
      salt: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.field_key).concat(_descriptor_0.toValue(value_0.salt)));
  }
}

const _descriptor_25 = new _AbsentLeaf_0();

class _MerkleNode_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      left: _descriptor_0.fromValue(value_0),
      right: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.left).concat(_descriptor_0.toValue(value_0.right)));
  }
}

const _descriptor_26 = new _MerkleNode_0();

class _FieldLeaf_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_1.alignment().concat(_descriptor_0.alignment())));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      field_key: _descriptor_0.fromValue(value_0),
      value: _descriptor_1.fromValue(value_0),
      salt: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.field_key).concat(_descriptor_1.toValue(value_0.value).concat(_descriptor_0.toValue(value_0.salt))));
  }
}

const _descriptor_27 = new _FieldLeaf_0();

class _BytesLeaf_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment())));
  }
  fromValue(value_0) {
    return {
      tag: _descriptor_4.fromValue(value_0),
      field_key: _descriptor_0.fromValue(value_0),
      value_digest: _descriptor_0.fromValue(value_0),
      salt: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.tag).concat(_descriptor_0.toValue(value_0.field_key).concat(_descriptor_0.toValue(value_0.value_digest).concat(_descriptor_0.toValue(value_0.salt))));
  }
}

const _descriptor_28 = new _BytesLeaf_0();

class _Either_0 {
  alignment() {
    return _descriptor_3.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_3.fromValue(value_0),
      left: _descriptor_0.fromValue(value_0),
      right: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_3.toValue(value_0.is_left).concat(_descriptor_0.toValue(value_0.left).concat(_descriptor_0.toValue(value_0.right)));
  }
}

const _descriptor_29 = new _Either_0();

const _descriptor_30 = new __compactRuntime.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_31 = new _ContractAddress_0();

export class Contract {
  witnesses;
  constructor(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract constructor: expected 1 argument, received ${args_0.length}`);
    }
    const witnesses_0 = args_0[0];
    if (typeof(witnesses_0) !== 'object') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor is not an object');
    }
    if (typeof(witnesses_0.local_secret_key) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named local_secret_key');
    }
    if (typeof(witnesses_0.field_value) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named field_value');
    }
    if (typeof(witnesses_0.field_salt) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named field_salt');
    }
    if (typeof(witnesses_0.merkle_siblings) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named merkle_siblings');
    }
    if (typeof(witnesses_0.merkle_dirs) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named merkle_dirs');
    }
    if (typeof(witnesses_0.field_digest) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named field_digest');
    }
    if (typeof(witnesses_0.set_siblings) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named set_siblings');
    }
    if (typeof(witnesses_0.set_dirs) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named set_dirs');
    }
    if (typeof(witnesses_0.doc_schema) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named doc_schema');
    }
    if (typeof(witnesses_0.doc_salt_a) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named doc_salt_a');
    }
    if (typeof(witnesses_0.doc_salt_b) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named doc_salt_b');
    }
    if (typeof(witnesses_0.doc_slots_a) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named doc_slots_a');
    }
    if (typeof(witnesses_0.doc_slots_b) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named doc_slots_b');
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      leafHash(context, ...args_1) {
        return { result: pureCircuits.leafHash(...args_1), context };
      },
      bytesLeafHash(context, ...args_1) {
        return { result: pureCircuits.bytesLeafHash(...args_1), context };
      },
      absentLeafHash(context, ...args_1) {
        return { result: pureCircuits.absentLeafHash(...args_1), context };
      },
      nodeHash(context, ...args_1) {
        return { result: pureCircuits.nodeHash(...args_1), context };
      },
      setLeafHash(context, ...args_1) {
        return { result: pureCircuits.setLeafHash(...args_1), context };
      },
      descriptorLeafHash(context, ...args_1) {
        return { result: pureCircuits.descriptorLeafHash(...args_1), context };
      },
      slotSalt(context, ...args_1) {
        return { result: pureCircuits.slotSalt(...args_1), context };
      },
      emptyLeafKey(context, ...args_1) {
        return { result: pureCircuits.emptyLeafKey(...args_1), context };
      },
      recordKey(context, ...args_1) {
        return { result: pureCircuits.recordKey(...args_1), context };
      },
      attest: (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`attest: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const payload_hash_0 = args_1[1];
        const metadata_hash_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('attest',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 531 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(payload_hash_0.buffer instanceof ArrayBuffer && payload_hash_0.BYTES_PER_ELEMENT === 1 && payload_hash_0.length === 32)) {
          __compactRuntime.typeError('attest',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 531 char 1',
                                     'Bytes<32>',
                                     payload_hash_0)
        }
        if (!(metadata_hash_0.buffer instanceof ArrayBuffer && metadata_hash_0.BYTES_PER_ELEMENT === 1 && metadata_hash_0.length === 32)) {
          __compactRuntime.typeError('attest',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 531 char 1',
                                     'Bytes<32>',
                                     metadata_hash_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(payload_hash_0).concat(_descriptor_0.toValue(metadata_hash_0)),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._attest_0(context,
                                        partialProofData,
                                        payload_hash_0,
                                        metadata_hash_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      retract: (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`retract: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const mode_0 = args_1[1];
        const key_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('retract',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 545 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(mode_0) === 'bigint' && mode_0 >= 0n && mode_0 <= 255n)) {
          __compactRuntime.typeError('retract',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 545 char 1',
                                     'Uint<0..256>',
                                     mode_0)
        }
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('retract',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 545 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_4.toValue(mode_0).concat(_descriptor_0.toValue(key_0)),
            alignment: _descriptor_4.alignment().concat(_descriptor_0.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._retract_0(context,
                                         partialProofData,
                                         mode_0,
                                         key_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      grantDisclosure: (...args_1) => {
        if (args_1.length !== 4) {
          throw new __compactRuntime.CompactError(`grantDisclosure: expected 4 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const payload_hash_0 = args_1[1];
        const grantee_0 = args_1[2];
        const level_0 = args_1[3];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('grantDisclosure',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 559 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(payload_hash_0.buffer instanceof ArrayBuffer && payload_hash_0.BYTES_PER_ELEMENT === 1 && payload_hash_0.length === 32)) {
          __compactRuntime.typeError('grantDisclosure',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 559 char 1',
                                     'Bytes<32>',
                                     payload_hash_0)
        }
        if (!(grantee_0.buffer instanceof ArrayBuffer && grantee_0.BYTES_PER_ELEMENT === 1 && grantee_0.length === 32)) {
          __compactRuntime.typeError('grantDisclosure',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 559 char 1',
                                     'Bytes<32>',
                                     grantee_0)
        }
        if (!(typeof(level_0) === 'bigint' && level_0 >= 0n && level_0 <= 255n)) {
          __compactRuntime.typeError('grantDisclosure',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'attestation-vault.compact line 559 char 1',
                                     'Uint<0..256>',
                                     level_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(payload_hash_0).concat(_descriptor_0.toValue(grantee_0).concat(_descriptor_4.toValue(level_0))),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_4.alignment()))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._grantDisclosure_0(context,
                                                 partialProofData,
                                                 payload_hash_0,
                                                 grantee_0,
                                                 level_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      revokeDisclosure: (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`revokeDisclosure: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const payload_hash_0 = args_1[1];
        const grantee_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('revokeDisclosure',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 574 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(payload_hash_0.buffer instanceof ArrayBuffer && payload_hash_0.BYTES_PER_ELEMENT === 1 && payload_hash_0.length === 32)) {
          __compactRuntime.typeError('revokeDisclosure',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 574 char 1',
                                     'Bytes<32>',
                                     payload_hash_0)
        }
        if (!(grantee_0.buffer instanceof ArrayBuffer && grantee_0.BYTES_PER_ELEMENT === 1 && grantee_0.length === 32)) {
          __compactRuntime.typeError('revokeDisclosure',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 574 char 1',
                                     'Bytes<32>',
                                     grantee_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(payload_hash_0).concat(_descriptor_0.toValue(grantee_0)),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._revokeDisclosure_0(context,
                                                  partialProofData,
                                                  payload_hash_0,
                                                  grantee_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      registerDocument: (...args_1) => {
        if (args_1.length !== 4) {
          throw new __compactRuntime.CompactError(`registerDocument: expected 4 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const mode_0 = args_1[1];
        const document_id_0 = args_1[2];
        const owner_id_0 = args_1[3];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('registerDocument',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 606 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(mode_0) === 'bigint' && mode_0 >= 0n && mode_0 <= 255n)) {
          __compactRuntime.typeError('registerDocument',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 606 char 1',
                                     'Uint<0..256>',
                                     mode_0)
        }
        if (!(document_id_0.buffer instanceof ArrayBuffer && document_id_0.BYTES_PER_ELEMENT === 1 && document_id_0.length === 32)) {
          __compactRuntime.typeError('registerDocument',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 606 char 1',
                                     'Bytes<32>',
                                     document_id_0)
        }
        if (!(owner_id_0.buffer instanceof ArrayBuffer && owner_id_0.BYTES_PER_ELEMENT === 1 && owner_id_0.length === 32)) {
          __compactRuntime.typeError('registerDocument',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'attestation-vault.compact line 606 char 1',
                                     'Bytes<32>',
                                     owner_id_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_4.toValue(mode_0).concat(_descriptor_0.toValue(document_id_0).concat(_descriptor_0.toValue(owner_id_0))),
            alignment: _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._registerDocument_0(context,
                                                  partialProofData,
                                                  mode_0,
                                                  document_id_0,
                                                  owner_id_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      bindDocument: (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`bindDocument: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const document_id_0 = args_1[1];
        const payload_hash_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('bindDocument',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 646 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(document_id_0.buffer instanceof ArrayBuffer && document_id_0.BYTES_PER_ELEMENT === 1 && document_id_0.length === 32)) {
          __compactRuntime.typeError('bindDocument',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 646 char 1',
                                     'Bytes<32>',
                                     document_id_0)
        }
        if (!(payload_hash_0.buffer instanceof ArrayBuffer && payload_hash_0.BYTES_PER_ELEMENT === 1 && payload_hash_0.length === 32)) {
          __compactRuntime.typeError('bindDocument',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 646 char 1',
                                     'Bytes<32>',
                                     payload_hash_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(document_id_0).concat(_descriptor_0.toValue(payload_hash_0)),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._bindDocument_0(context,
                                              partialProofData,
                                              document_id_0,
                                              payload_hash_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      anchorContentRoot: (...args_1) => {
        if (args_1.length !== 4) {
          throw new __compactRuntime.CompactError(`anchorContentRoot: expected 4 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const payload_hash_0 = args_1[1];
        const content_root_0 = args_1[2];
        const schema_id_0 = args_1[3];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('anchorContentRoot',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 688 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(payload_hash_0.buffer instanceof ArrayBuffer && payload_hash_0.BYTES_PER_ELEMENT === 1 && payload_hash_0.length === 32)) {
          __compactRuntime.typeError('anchorContentRoot',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 688 char 1',
                                     'Bytes<32>',
                                     payload_hash_0)
        }
        if (!(content_root_0.buffer instanceof ArrayBuffer && content_root_0.BYTES_PER_ELEMENT === 1 && content_root_0.length === 32)) {
          __compactRuntime.typeError('anchorContentRoot',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 688 char 1',
                                     'Bytes<32>',
                                     content_root_0)
        }
        if (!(schema_id_0.buffer instanceof ArrayBuffer && schema_id_0.BYTES_PER_ELEMENT === 1 && schema_id_0.length === 32)) {
          __compactRuntime.typeError('anchorContentRoot',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'attestation-vault.compact line 688 char 1',
                                     'Bytes<32>',
                                     schema_id_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(payload_hash_0).concat(_descriptor_0.toValue(content_root_0).concat(_descriptor_0.toValue(schema_id_0))),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._anchorContentRoot_0(context,
                                                   partialProofData,
                                                   payload_hash_0,
                                                   content_root_0,
                                                   schema_id_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      proveFieldPredicate: (...args_1) => {
        if (args_1.length !== 6) {
          throw new __compactRuntime.CompactError(`proveFieldPredicate: expected 6 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const record_key_0 = args_1[1];
        const field_key_0 = args_1[2];
        const threshold_0 = args_1[3];
        const op_0 = args_1[4];
        const valid_until_0 = args_1[5];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('proveFieldPredicate',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 723 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(record_key_0.buffer instanceof ArrayBuffer && record_key_0.BYTES_PER_ELEMENT === 1 && record_key_0.length === 32)) {
          __compactRuntime.typeError('proveFieldPredicate',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 723 char 1',
                                     'Bytes<32>',
                                     record_key_0)
        }
        if (!(field_key_0.buffer instanceof ArrayBuffer && field_key_0.BYTES_PER_ELEMENT === 1 && field_key_0.length === 32)) {
          __compactRuntime.typeError('proveFieldPredicate',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 723 char 1',
                                     'Bytes<32>',
                                     field_key_0)
        }
        if (!(typeof(threshold_0) === 'bigint' && threshold_0 >= 0n && threshold_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('proveFieldPredicate',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'attestation-vault.compact line 723 char 1',
                                     'Uint<0..18446744073709551616>',
                                     threshold_0)
        }
        if (!(typeof(op_0) === 'bigint' && op_0 >= 0n && op_0 <= 255n)) {
          __compactRuntime.typeError('proveFieldPredicate',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'attestation-vault.compact line 723 char 1',
                                     'Uint<0..256>',
                                     op_0)
        }
        if (!(typeof(valid_until_0) === 'bigint' && valid_until_0 >= 0n && valid_until_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('proveFieldPredicate',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'attestation-vault.compact line 723 char 1',
                                     'Uint<0..18446744073709551616>',
                                     valid_until_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(record_key_0).concat(_descriptor_0.toValue(field_key_0).concat(_descriptor_1.toValue(threshold_0).concat(_descriptor_4.toValue(op_0).concat(_descriptor_1.toValue(valid_until_0))))),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_1.alignment().concat(_descriptor_4.alignment().concat(_descriptor_1.alignment()))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._proveFieldPredicate_0(context,
                                                     partialProofData,
                                                     record_key_0,
                                                     field_key_0,
                                                     threshold_0,
                                                     op_0,
                                                     valid_until_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      proveFieldEquality: (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`proveFieldEquality: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const record_key_0 = args_1[1];
        const field_key_0 = args_1[2];
        const expected_digest_0 = args_1[3];
        const valid_until_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('proveFieldEquality',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 760 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(record_key_0.buffer instanceof ArrayBuffer && record_key_0.BYTES_PER_ELEMENT === 1 && record_key_0.length === 32)) {
          __compactRuntime.typeError('proveFieldEquality',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 760 char 1',
                                     'Bytes<32>',
                                     record_key_0)
        }
        if (!(field_key_0.buffer instanceof ArrayBuffer && field_key_0.BYTES_PER_ELEMENT === 1 && field_key_0.length === 32)) {
          __compactRuntime.typeError('proveFieldEquality',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 760 char 1',
                                     'Bytes<32>',
                                     field_key_0)
        }
        if (!(expected_digest_0.buffer instanceof ArrayBuffer && expected_digest_0.BYTES_PER_ELEMENT === 1 && expected_digest_0.length === 32)) {
          __compactRuntime.typeError('proveFieldEquality',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'attestation-vault.compact line 760 char 1',
                                     'Bytes<32>',
                                     expected_digest_0)
        }
        if (!(typeof(valid_until_0) === 'bigint' && valid_until_0 >= 0n && valid_until_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('proveFieldEquality',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'attestation-vault.compact line 760 char 1',
                                     'Uint<0..18446744073709551616>',
                                     valid_until_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(record_key_0).concat(_descriptor_0.toValue(field_key_0).concat(_descriptor_0.toValue(expected_digest_0).concat(_descriptor_1.toValue(valid_until_0)))),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_1.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._proveFieldEquality_0(context,
                                                    partialProofData,
                                                    record_key_0,
                                                    field_key_0,
                                                    expected_digest_0,
                                                    valid_until_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      proveFieldMembership: (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`proveFieldMembership: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const record_key_0 = args_1[1];
        const field_key_0 = args_1[2];
        const set_root_0 = args_1[3];
        const valid_until_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('proveFieldMembership',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 786 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(record_key_0.buffer instanceof ArrayBuffer && record_key_0.BYTES_PER_ELEMENT === 1 && record_key_0.length === 32)) {
          __compactRuntime.typeError('proveFieldMembership',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 786 char 1',
                                     'Bytes<32>',
                                     record_key_0)
        }
        if (!(field_key_0.buffer instanceof ArrayBuffer && field_key_0.BYTES_PER_ELEMENT === 1 && field_key_0.length === 32)) {
          __compactRuntime.typeError('proveFieldMembership',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 786 char 1',
                                     'Bytes<32>',
                                     field_key_0)
        }
        if (!(set_root_0.buffer instanceof ArrayBuffer && set_root_0.BYTES_PER_ELEMENT === 1 && set_root_0.length === 32)) {
          __compactRuntime.typeError('proveFieldMembership',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'attestation-vault.compact line 786 char 1',
                                     'Bytes<32>',
                                     set_root_0)
        }
        if (!(typeof(valid_until_0) === 'bigint' && valid_until_0 >= 0n && valid_until_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('proveFieldMembership',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'attestation-vault.compact line 786 char 1',
                                     'Uint<0..18446744073709551616>',
                                     valid_until_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(record_key_0).concat(_descriptor_0.toValue(field_key_0).concat(_descriptor_0.toValue(set_root_0).concat(_descriptor_1.toValue(valid_until_0)))),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_1.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._proveFieldMembership_0(context,
                                                      partialProofData,
                                                      record_key_0,
                                                      field_key_0,
                                                      set_root_0,
                                                      valid_until_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      proveDocumentComparison: (...args_1) => {
        if (args_1.length !== 7) {
          throw new __compactRuntime.CompactError(`proveDocumentComparison: expected 7 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const record_key_a_0 = args_1[1];
        const record_key_b_0 = args_1[2];
        const mode_0 = args_1[3];
        const allowed_mask_0 = args_1[4];
        const k_0 = args_1[5];
        const valid_until_0 = args_1[6];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('proveDocumentComparison',
                                     'argument 1 (as invoked from Typescript)',
                                     'attestation-vault.compact line 828 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(record_key_a_0.buffer instanceof ArrayBuffer && record_key_a_0.BYTES_PER_ELEMENT === 1 && record_key_a_0.length === 32)) {
          __compactRuntime.typeError('proveDocumentComparison',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'attestation-vault.compact line 828 char 1',
                                     'Bytes<32>',
                                     record_key_a_0)
        }
        if (!(record_key_b_0.buffer instanceof ArrayBuffer && record_key_b_0.BYTES_PER_ELEMENT === 1 && record_key_b_0.length === 32)) {
          __compactRuntime.typeError('proveDocumentComparison',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'attestation-vault.compact line 828 char 1',
                                     'Bytes<32>',
                                     record_key_b_0)
        }
        if (!(typeof(mode_0) === 'bigint' && mode_0 >= 0n && mode_0 <= 255n)) {
          __compactRuntime.typeError('proveDocumentComparison',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'attestation-vault.compact line 828 char 1',
                                     'Uint<0..256>',
                                     mode_0)
        }
        if (!(Array.isArray(allowed_mask_0) && allowed_mask_0.length === 16 && allowed_mask_0.every((t) => typeof(t) === 'boolean'))) {
          __compactRuntime.typeError('proveDocumentComparison',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'attestation-vault.compact line 828 char 1',
                                     'Vector<16, Boolean>',
                                     allowed_mask_0)
        }
        if (!(typeof(k_0) === 'bigint' && k_0 >= 0n && k_0 <= 255n)) {
          __compactRuntime.typeError('proveDocumentComparison',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'attestation-vault.compact line 828 char 1',
                                     'Uint<0..256>',
                                     k_0)
        }
        if (!(typeof(valid_until_0) === 'bigint' && valid_until_0 >= 0n && valid_until_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('proveDocumentComparison',
                                     'argument 6 (argument 7 as invoked from Typescript)',
                                     'attestation-vault.compact line 828 char 1',
                                     'Uint<0..18446744073709551616>',
                                     valid_until_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(record_key_a_0).concat(_descriptor_0.toValue(record_key_b_0).concat(_descriptor_4.toValue(mode_0).concat(_descriptor_5.toValue(allowed_mask_0).concat(_descriptor_4.toValue(k_0).concat(_descriptor_1.toValue(valid_until_0)))))),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_4.alignment().concat(_descriptor_5.alignment().concat(_descriptor_4.alignment().concat(_descriptor_1.alignment())))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._proveDocumentComparison_0(context,
                                                         partialProofData,
                                                         record_key_a_0,
                                                         record_key_b_0,
                                                         mode_0,
                                                         allowed_mask_0,
                                                         k_0,
                                                         valid_until_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      }
    };
    this.impureCircuits = {
      attest: this.circuits.attest,
      retract: this.circuits.retract,
      grantDisclosure: this.circuits.grantDisclosure,
      revokeDisclosure: this.circuits.revokeDisclosure,
      registerDocument: this.circuits.registerDocument,
      bindDocument: this.circuits.bindDocument,
      anchorContentRoot: this.circuits.anchorContentRoot,
      proveFieldPredicate: this.circuits.proveFieldPredicate,
      proveFieldEquality: this.circuits.proveFieldEquality,
      proveFieldMembership: this.circuits.proveFieldMembership,
      proveDocumentComparison: this.circuits.proveDocumentComparison
    };
    this.provableCircuits = {
      attest: this.circuits.attest,
      retract: this.circuits.retract,
      grantDisclosure: this.circuits.grantDisclosure,
      revokeDisclosure: this.circuits.revokeDisclosure,
      registerDocument: this.circuits.registerDocument,
      bindDocument: this.circuits.bindDocument,
      anchorContentRoot: this.circuits.anchorContentRoot,
      proveFieldPredicate: this.circuits.proveFieldPredicate,
      proveFieldEquality: this.circuits.proveFieldEquality,
      proveFieldMembership: this.circuits.proveFieldMembership,
      proveDocumentComparison: this.circuits.proveDocumentComparison
    };
  }
  initialState(...args_0) {
    if (args_0.length !== 3) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 3 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const constructorContext_0 = args_0[0];
    const initial_registrar_0 = args_0[1];
    const initial_recovery_0 = args_0[2];
    if (typeof(constructorContext_0) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'constructorContext' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!('initialPrivateState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialPrivateState' in argument 1 (as invoked from Typescript)`);
    }
    if (!('initialZswapLocalState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript)`);
    }
    if (typeof(constructorContext_0.initialZswapLocalState) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!(initial_registrar_0.buffer instanceof ArrayBuffer && initial_registrar_0.BYTES_PER_ELEMENT === 1 && initial_registrar_0.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 1 (argument 2 as invoked from Typescript)',
                                 'attestation-vault.compact line 255 char 1',
                                 'Bytes<32>',
                                 initial_registrar_0)
    }
    if (!(initial_recovery_0.buffer instanceof ArrayBuffer && initial_recovery_0.BYTES_PER_ELEMENT === 1 && initial_recovery_0.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 2 (argument 3 as invoked from Typescript)',
                                 'attestation-vault.compact line 255 char 1',
                                 'Bytes<32>',
                                 initial_recovery_0)
    }
    const state_0 = new __compactRuntime.ContractState();
    let stateValue_0 = __compactRuntime.StateValue.newArray();
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation('attest', new __compactRuntime.ContractOperation());
    state_0.setOperation('retract', new __compactRuntime.ContractOperation());
    state_0.setOperation('grantDisclosure', new __compactRuntime.ContractOperation());
    state_0.setOperation('revokeDisclosure', new __compactRuntime.ContractOperation());
    state_0.setOperation('registerDocument', new __compactRuntime.ContractOperation());
    state_0.setOperation('bindDocument', new __compactRuntime.ContractOperation());
    state_0.setOperation('anchorContentRoot', new __compactRuntime.ContractOperation());
    state_0.setOperation('proveFieldPredicate', new __compactRuntime.ContractOperation());
    state_0.setOperation('proveFieldEquality', new __compactRuntime.ContractOperation());
    state_0.setOperation('proveFieldMembership', new __compactRuntime.ContractOperation());
    state_0.setOperation('proveDocumentComparison', new __compactRuntime.ContractOperation());
    const context = __compactRuntime.createCircuitContext(__compactRuntime.dummyContractAddress(), constructorContext_0.initialZswapLocalState.coinPublicKey, state_0.data, constructorContext_0.initialPrivateState);
    const partialProofData = {
      input: { value: [], alignment: [] },
      output: undefined,
      publicTranscript: [],
      privateTranscriptOutputs: []
    };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(0n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(1n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(2n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(3n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(4n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(5n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(6n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(7n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(4n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(initial_registrar_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(6n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(initial_recovery_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    state_0.data = new __compactRuntime.ChargedState(context.currentQueryContext.state.state);
    return {
      currentContractState: state_0,
      currentPrivateState: context.currentPrivateState,
      currentZswapLocalState: context.currentZswapLocalState
    }
  }
  _transientHash_0(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_27, value_0);
    return result_0;
  }
  _transientHash_1(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_28, value_0);
    return result_0;
  }
  _transientHash_2(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_25, value_0);
    return result_0;
  }
  _transientHash_3(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_26, value_0);
    return result_0;
  }
  _transientHash_4(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_23, value_0);
    return result_0;
  }
  _transientHash_5(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_24, value_0);
    return result_0;
  }
  _transientHash_6(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_21, value_0);
    return result_0;
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_22, value_0);
    return result_0;
  }
  _persistentHash_1(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_0, value_0);
    return result_0;
  }
  _persistentHash_2(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_20, value_0);
    return result_0;
  }
  _persistentHash_3(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_18, value_0);
    return result_0;
  }
  _persistentHash_4(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_19, value_0);
    return result_0;
  }
  _persistentHash_5(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_16, value_0);
    return result_0;
  }
  _persistentHash_6(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_17, value_0);
    return result_0;
  }
  _upgradeFromTransient_0(x_0) {
    const result_0 = __compactRuntime.upgradeFromTransient(x_0);
    return result_0;
  }
  _local_secret_key_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.local_secret_key(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('local_secret_key',
                                 'return value',
                                 'attestation-vault.compact line 212 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  _field_value_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.field_value(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(typeof(result_0) === 'bigint' && result_0 >= 0n && result_0 <= 18446744073709551615n)) {
      __compactRuntime.typeError('field_value',
                                 'return value',
                                 'attestation-vault.compact line 216 char 1',
                                 'Uint<0..18446744073709551616>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_1.toValue(result_0),
      alignment: _descriptor_1.alignment()
    });
    return result_0;
  }
  _field_salt_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.field_salt(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('field_salt',
                                 'return value',
                                 'attestation-vault.compact line 217 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  _merkle_siblings_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.merkle_siblings(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(Array.isArray(result_0) && result_0.length === 4 && result_0.every((t) => t.buffer instanceof ArrayBuffer && t.BYTES_PER_ELEMENT === 1 && t.length === 32))) {
      __compactRuntime.typeError('merkle_siblings',
                                 'return value',
                                 'attestation-vault.compact line 218 char 1',
                                 'Vector<4, Bytes<32>>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_13.toValue(result_0),
      alignment: _descriptor_13.alignment()
    });
    return result_0;
  }
  _merkle_dirs_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.merkle_dirs(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(Array.isArray(result_0) && result_0.length === 4 && result_0.every((t) => typeof(t) === 'boolean'))) {
      __compactRuntime.typeError('merkle_dirs',
                                 'return value',
                                 'attestation-vault.compact line 219 char 1',
                                 'Vector<4, Boolean>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_14.toValue(result_0),
      alignment: _descriptor_14.alignment()
    });
    return result_0;
  }
  _field_digest_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.field_digest(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('field_digest',
                                 'return value',
                                 'attestation-vault.compact line 224 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  _set_siblings_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.set_siblings(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(Array.isArray(result_0) && result_0.length === 6 && result_0.every((t) => t.buffer instanceof ArrayBuffer && t.BYTES_PER_ELEMENT === 1 && t.length === 32))) {
      __compactRuntime.typeError('set_siblings',
                                 'return value',
                                 'attestation-vault.compact line 225 char 1',
                                 'Vector<6, Bytes<32>>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_12.toValue(result_0),
      alignment: _descriptor_12.alignment()
    });
    return result_0;
  }
  _set_dirs_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.set_dirs(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(Array.isArray(result_0) && result_0.length === 6 && result_0.every((t) => typeof(t) === 'boolean'))) {
      __compactRuntime.typeError('set_dirs',
                                 'return value',
                                 'attestation-vault.compact line 226 char 1',
                                 'Vector<6, Boolean>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_11.toValue(result_0),
      alignment: _descriptor_11.alignment()
    });
    return result_0;
  }
  _doc_schema_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.doc_schema(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(Array.isArray(result_0) && result_0.length === 16 && result_0.every((t) => typeof(t) === 'object' && t.field_key.buffer instanceof ArrayBuffer && t.field_key.BYTES_PER_ELEMENT === 1 && t.field_key.length === 32 && typeof(t.kind) === 'bigint' && t.kind >= 0n && t.kind <= 255n && typeof(t.scale) === 'bigint' && t.scale >= 0n && t.scale <= 18446744073709551615n))) {
      __compactRuntime.typeError('doc_schema',
                                 'return value',
                                 'attestation-vault.compact line 231 char 1',
                                 'Vector<16, struct SlotSpec<field_key: Bytes<32>, kind: Uint<0..256>, scale: Uint<0..18446744073709551616>>>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_8.toValue(result_0),
      alignment: _descriptor_8.alignment()
    });
    return result_0;
  }
  _doc_salt_a_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.doc_salt_a(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('doc_salt_a',
                                 'return value',
                                 'attestation-vault.compact line 232 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  _doc_salt_b_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.doc_salt_b(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('doc_salt_b',
                                 'return value',
                                 'attestation-vault.compact line 233 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  _doc_slots_a_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.doc_slots_a(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(Array.isArray(result_0) && result_0.length === 16 && result_0.every((t) => typeof(t) === 'object' && typeof(t.present) === 'boolean' && typeof(t.uint_value) === 'bigint' && t.uint_value >= 0n && t.uint_value <= 18446744073709551615n && t.value_digest.buffer instanceof ArrayBuffer && t.value_digest.BYTES_PER_ELEMENT === 1 && t.value_digest.length === 32))) {
      __compactRuntime.typeError('doc_slots_a',
                                 'return value',
                                 'attestation-vault.compact line 234 char 1',
                                 'Vector<16, struct SlotOpening<present: Boolean, uint_value: Uint<0..18446744073709551616>, value_digest: Bytes<32>>>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_10.toValue(result_0),
      alignment: _descriptor_10.alignment()
    });
    return result_0;
  }
  _doc_slots_b_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.doc_slots_b(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(Array.isArray(result_0) && result_0.length === 16 && result_0.every((t) => typeof(t) === 'object' && typeof(t.present) === 'boolean' && typeof(t.uint_value) === 'bigint' && t.uint_value >= 0n && t.uint_value <= 18446744073709551615n && t.value_digest.buffer instanceof ArrayBuffer && t.value_digest.BYTES_PER_ELEMENT === 1 && t.value_digest.length === 32))) {
      __compactRuntime.typeError('doc_slots_b',
                                 'return value',
                                 'attestation-vault.compact line 235 char 1',
                                 'Vector<16, struct SlotOpening<present: Boolean, uint_value: Uint<0..18446744073709551616>, value_digest: Bytes<32>>>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_10.toValue(result_0),
      alignment: _descriptor_10.alignment()
    });
    return result_0;
  }
  _maxClaimLifetime_0() { return 157680000n; }
  _caller_id_0(context, partialProofData) {
    return this._persistentHash_1(this._local_secret_key_0(context,
                                                           partialProofData));
  }
  _leafHash_0(field_key_0, value_0, salt_0) {
    return this._upgradeFromTransient_0(this._transientHash_0({ tag: 1n,
                                                                field_key:
                                                                  field_key_0,
                                                                value: value_0,
                                                                salt: salt_0 }));
  }
  _bytesLeafHash_0(field_key_0, value_digest_0, salt_0) {
    return this._upgradeFromTransient_0(this._transientHash_1({ tag: 2n,
                                                                field_key:
                                                                  field_key_0,
                                                                value_digest:
                                                                  value_digest_0,
                                                                salt: salt_0 }));
  }
  _absentLeafHash_0(field_key_0, salt_0) {
    return this._upgradeFromTransient_0(this._transientHash_2({ tag: 3n,
                                                                field_key:
                                                                  field_key_0,
                                                                salt: salt_0 }));
  }
  _nodeHash_0(left_0, right_0) {
    return this._upgradeFromTransient_0(this._transientHash_3({ tag: 4n,
                                                                left: left_0,
                                                                right: right_0 }));
  }
  _setLeafHash_0(value_digest_0) {
    return this._upgradeFromTransient_0(this._transientHash_4({ tag: 5n,
                                                                value_digest:
                                                                  value_digest_0 }));
  }
  _descriptorLeafHash_0(field_key_0, kind_0, scale_0) {
    return this._upgradeFromTransient_0(this._transientHash_5({ tag: 6n,
                                                                field_key:
                                                                  field_key_0,
                                                                kind: kind_0,
                                                                scale: scale_0 }));
  }
  _slotSalt_0(seed_0, index_0) {
    return this._upgradeFromTransient_0(this._transientHash_6({ tag: 7n,
                                                                seed: seed_0,
                                                                index: index_0 }));
  }
  _emptyLeafKey_0() {
    return new Uint8Array([110, 105, 103, 104, 116, 103, 97, 116, 101, 47, 101, 109, 112, 116, 121, 45, 108, 101, 97, 102, 47, 118, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  _recordKey_0(owner_0, payload_hash_0) {
    return this._persistentHash_0({ tag: 21n,
                                    owner: owner_0,
                                    payload_hash: payload_hash_0 });
  }
  _fold16_0(l0_0,
            l1_0,
            l2_0,
            l3_0,
            l4_0,
            l5_0,
            l6_0,
            l7_0,
            l8_0,
            l9_0,
            l10_0,
            l11_0,
            l12_0,
            l13_0,
            l14_0,
            l15_0)
  {
    const a0_0 = this._nodeHash_0(l0_0, l1_0);
    const a1_0 = this._nodeHash_0(l2_0, l3_0);
    const a2_0 = this._nodeHash_0(l4_0, l5_0);
    const a3_0 = this._nodeHash_0(l6_0, l7_0);
    const a4_0 = this._nodeHash_0(l8_0, l9_0);
    const a5_0 = this._nodeHash_0(l10_0, l11_0);
    const a6_0 = this._nodeHash_0(l12_0, l13_0);
    const a7_0 = this._nodeHash_0(l14_0, l15_0);
    const b0_0 = this._nodeHash_0(a0_0, a1_0);
    const b1_0 = this._nodeHash_0(a2_0, a3_0);
    const b2_0 = this._nodeHash_0(a4_0, a5_0);
    const b3_0 = this._nodeHash_0(a6_0, a7_0);
    return this._nodeHash_0(this._nodeHash_0(b0_0, b1_0),
                            this._nodeHash_0(b2_0, b3_0));
  }
  _slotLeaf_0(d_0, o_0, salt_0) {
    if (this._equal_0(d_0.kind, 0n) && o_0.present) {
      return this._leafHash_0(d_0.field_key, o_0.uint_value, salt_0);
    } else {
      if (this._equal_1(d_0.kind, 1n) && o_0.present) {
        return this._bytesLeafHash_0(d_0.field_key, o_0.value_digest, salt_0);
      } else {
        return this._absentLeafHash_0(d_0.field_key, salt_0);
      }
    }
  }
  _slotDiff_0(d_0, a_0, b_0) {
    return this._equal_2(d_0.kind, 2n) ?
           0n :
           !a_0.present && !b_0.present ?
           0n :
           a_0.present && !b_0.present || !a_0.present && b_0.present ?
           1n :
           this._equal_3(d_0.kind, 0n) ?
           this._equal_4(a_0.uint_value, b_0.uint_value) ? 0n : 1n :
           this._equal_5(a_0.value_digest, b_0.value_digest) ? 0n : 1n;
  }
  _assertCanonicalSlot_0(d_0, a_0, b_0) {
    let t_0;
    __compactRuntime.assert((t_0 = d_0.kind, t_0 <= 2n),
                            'schema kind out of range');
    if (this._equal_6(d_0.kind, 2n)) {
      __compactRuntime.assert(this._equal_7(d_0.field_key,
                                            this._emptyLeafKey_0()),
                              'padding slot key must be canonical');
      __compactRuntime.assert(!a_0.present && !b_0.present,
                              'padding slot must be absent');
    } else {
      __compactRuntime.assert(!this._equal_8(d_0.field_key,
                                             this._emptyLeafKey_0()),
                              'padding key in a real slot');
    }
    if (!this._equal_9(d_0.kind, 0n)) {
      __compactRuntime.assert(this._equal_10(d_0.scale, 0n),
                              'schema scale must be 0 for non-uint slots');
    }
    return [];
  }
  _constrainsSlot_0(allowed_0, d_0) {
    return !allowed_0 && !this._equal_11(d_0.kind, 2n);
  }
  _assertUnchanged_0(allowed_0, d_0, a_0, b_0) {
    if (!allowed_0) {
      __compactRuntime.assert(this._equal_12(this._slotDiff_0(d_0, a_0, b_0), 0n),
                              'slot changed outside allowed mask');
    }
    return [];
  }
  _schemaRootOf_0(ds_0) {
    return this._fold16_0(this._descriptorLeafHash_0(ds_0[0].field_key,
                                                     ds_0[0].kind,
                                                     ds_0[0].scale),
                          this._descriptorLeafHash_0(ds_0[1].field_key,
                                                     ds_0[1].kind,
                                                     ds_0[1].scale),
                          this._descriptorLeafHash_0(ds_0[2].field_key,
                                                     ds_0[2].kind,
                                                     ds_0[2].scale),
                          this._descriptorLeafHash_0(ds_0[3].field_key,
                                                     ds_0[3].kind,
                                                     ds_0[3].scale),
                          this._descriptorLeafHash_0(ds_0[4].field_key,
                                                     ds_0[4].kind,
                                                     ds_0[4].scale),
                          this._descriptorLeafHash_0(ds_0[5].field_key,
                                                     ds_0[5].kind,
                                                     ds_0[5].scale),
                          this._descriptorLeafHash_0(ds_0[6].field_key,
                                                     ds_0[6].kind,
                                                     ds_0[6].scale),
                          this._descriptorLeafHash_0(ds_0[7].field_key,
                                                     ds_0[7].kind,
                                                     ds_0[7].scale),
                          this._descriptorLeafHash_0(ds_0[8].field_key,
                                                     ds_0[8].kind,
                                                     ds_0[8].scale),
                          this._descriptorLeafHash_0(ds_0[9].field_key,
                                                     ds_0[9].kind,
                                                     ds_0[9].scale),
                          this._descriptorLeafHash_0(ds_0[10].field_key,
                                                     ds_0[10].kind,
                                                     ds_0[10].scale),
                          this._descriptorLeafHash_0(ds_0[11].field_key,
                                                     ds_0[11].kind,
                                                     ds_0[11].scale),
                          this._descriptorLeafHash_0(ds_0[12].field_key,
                                                     ds_0[12].kind,
                                                     ds_0[12].scale),
                          this._descriptorLeafHash_0(ds_0[13].field_key,
                                                     ds_0[13].kind,
                                                     ds_0[13].scale),
                          this._descriptorLeafHash_0(ds_0[14].field_key,
                                                     ds_0[14].kind,
                                                     ds_0[14].scale),
                          this._descriptorLeafHash_0(ds_0[15].field_key,
                                                     ds_0[15].kind,
                                                     ds_0[15].scale));
  }
  _contentRootOf_0(ds_0, os_0, seed_0) {
    return this._fold16_0(this._slotLeaf_0(ds_0[0],
                                           os_0[0],
                                           this._slotSalt_0(seed_0, 0n)),
                          this._slotLeaf_0(ds_0[1],
                                           os_0[1],
                                           this._slotSalt_0(seed_0, 1n)),
                          this._slotLeaf_0(ds_0[2],
                                           os_0[2],
                                           this._slotSalt_0(seed_0, 2n)),
                          this._slotLeaf_0(ds_0[3],
                                           os_0[3],
                                           this._slotSalt_0(seed_0, 3n)),
                          this._slotLeaf_0(ds_0[4],
                                           os_0[4],
                                           this._slotSalt_0(seed_0, 4n)),
                          this._slotLeaf_0(ds_0[5],
                                           os_0[5],
                                           this._slotSalt_0(seed_0, 5n)),
                          this._slotLeaf_0(ds_0[6],
                                           os_0[6],
                                           this._slotSalt_0(seed_0, 6n)),
                          this._slotLeaf_0(ds_0[7],
                                           os_0[7],
                                           this._slotSalt_0(seed_0, 7n)),
                          this._slotLeaf_0(ds_0[8],
                                           os_0[8],
                                           this._slotSalt_0(seed_0, 8n)),
                          this._slotLeaf_0(ds_0[9],
                                           os_0[9],
                                           this._slotSalt_0(seed_0, 9n)),
                          this._slotLeaf_0(ds_0[10],
                                           os_0[10],
                                           this._slotSalt_0(seed_0, 10n)),
                          this._slotLeaf_0(ds_0[11],
                                           os_0[11],
                                           this._slotSalt_0(seed_0, 11n)),
                          this._slotLeaf_0(ds_0[12],
                                           os_0[12],
                                           this._slotSalt_0(seed_0, 12n)),
                          this._slotLeaf_0(ds_0[13],
                                           os_0[13],
                                           this._slotSalt_0(seed_0, 13n)),
                          this._slotLeaf_0(ds_0[14],
                                           os_0[14],
                                           this._slotSalt_0(seed_0, 14n)),
                          this._slotLeaf_0(ds_0[15],
                                           os_0[15],
                                           this._slotSalt_0(seed_0, 15n)));
  }
  _merkleStep_0(node_0, sibling_0, goesLeft_0) {
    if (goesLeft_0) {
      return this._nodeHash_0(node_0, sibling_0);
    } else {
      return this._nodeHash_0(sibling_0, node_0);
    }
  }
  _ownRecord_0(context, partialProofData, payload_hash_0) {
    return this._recordKey_0(this._caller_id_0(context, partialProofData),
                             payload_hash_0);
  }
  _ownAttestedRecord_0(context, partialProofData, payload_hash_0) {
    const key_0 = this._ownRecord_0(context, partialProofData, payload_hash_0);
    __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(0n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'no attestation');
    return key_0;
  }
  _anchorOf_0(context, partialProofData, record_key_0) {
    __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(1n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_key_0),
                                                                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'no content root');
    return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                     partialProofData,
                                                                     [
                                                                      { dup: { n: 0 } },
                                                                      { idx: { cached: false,
                                                                               pushPath: false,
                                                                               path: [
                                                                                      { tag: 'value',
                                                                                        value: { value: _descriptor_4.toValue(1n),
                                                                                                 alignment: _descriptor_4.alignment() } }] } },
                                                                      { idx: { cached: false,
                                                                               pushPath: false,
                                                                               path: [
                                                                                      { tag: 'value',
                                                                                        value: { value: _descriptor_0.toValue(record_key_0),
                                                                                                 alignment: _descriptor_0.alignment() } }] } },
                                                                      { popeq: { cached: false,
                                                                                 result: undefined } }]).value);
  }
  _unbindDocument_0(context, partialProofData, record_key_0) {
    const rec_0 = _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                            partialProofData,
                                                                            [
                                                                             { dup: { n: 0 } },
                                                                             { idx: { cached: false,
                                                                                      pushPath: false,
                                                                                      path: [
                                                                                             { tag: 'value',
                                                                                               value: { value: _descriptor_4.toValue(0n),
                                                                                                        alignment: _descriptor_4.alignment() } }] } },
                                                                             { idx: { cached: false,
                                                                                      pushPath: false,
                                                                                      path: [
                                                                                             { tag: 'value',
                                                                                               value: { value: _descriptor_0.toValue(record_key_0),
                                                                                                        alignment: _descriptor_0.alignment() } }] } },
                                                                             { popeq: { cached: false,
                                                                                        result: undefined } }]).value);
    if (!this._equal_13(rec_0.document_id,
                        new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))
    {
      let tmp_0;
      if (tmp_0 = rec_0.document_id,
          _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                    partialProofData,
                                                                    [
                                                                     { dup: { n: 0 } },
                                                                     { idx: { cached: false,
                                                                              pushPath: false,
                                                                              path: [
                                                                                     { tag: 'value',
                                                                                       value: { value: _descriptor_4.toValue(3n),
                                                                                                alignment: _descriptor_4.alignment() } }] } },
                                                                     { push: { storage: false,
                                                                               value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(tmp_0),
                                                                                                                            alignment: _descriptor_0.alignment() }).encode() } },
                                                                     'member',
                                                                     { popeq: { cached: true,
                                                                                result: undefined } }]).value))
      {
        let tmp_1;
        if (this._equal_14((tmp_1 = rec_0.document_id,
                            _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(3n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_0.toValue(tmp_1),
                                                                                                                  alignment: _descriptor_0.alignment() } }] } },
                                                                                       { popeq: { cached: false,
                                                                                                  result: undefined } }]).value)),
                           record_key_0))
        {
          const tmp_2 = rec_0.document_id;
          __compactRuntime.queryLedgerState(context,
                                            partialProofData,
                                            [
                                             { idx: { cached: false,
                                                      pushPath: true,
                                                      path: [
                                                             { tag: 'value',
                                                               value: { value: _descriptor_4.toValue(3n),
                                                                        alignment: _descriptor_4.alignment() } }] } },
                                             { push: { storage: false,
                                                       value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(tmp_2),
                                                                                                    alignment: _descriptor_0.alignment() }).encode() } },
                                             { rem: { cached: false } },
                                             { ins: { cached: true, n: 1 } }]);
        }
      }
    }
    return [];
  }
  _clearRecord_0(context, partialProofData, record_key_0) {
    this._unbindDocument_0(context, partialProofData, record_key_0);
    if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                  partialProofData,
                                                                  [
                                                                   { dup: { n: 0 } },
                                                                   { idx: { cached: false,
                                                                            pushPath: false,
                                                                            path: [
                                                                                   { tag: 'value',
                                                                                     value: { value: _descriptor_4.toValue(1n),
                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                   { push: { storage: false,
                                                                             value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_key_0),
                                                                                                                          alignment: _descriptor_0.alignment() }).encode() } },
                                                                   'member',
                                                                   { popeq: { cached: true,
                                                                              result: undefined } }]).value))
    {
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_4.toValue(1n),
                                                                    alignment: _descriptor_4.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_key_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { rem: { cached: false } },
                                         { ins: { cached: true, n: 1 } }]);
    }
    if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                  partialProofData,
                                                                  [
                                                                   { dup: { n: 0 } },
                                                                   { idx: { cached: false,
                                                                            pushPath: false,
                                                                            path: [
                                                                                   { tag: 'value',
                                                                                     value: { value: _descriptor_4.toValue(2n),
                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                   { push: { storage: false,
                                                                             value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_key_0),
                                                                                                                          alignment: _descriptor_0.alignment() }).encode() } },
                                                                   'member',
                                                                   { popeq: { cached: true,
                                                                              result: undefined } }]).value))
    {
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_4.toValue(2n),
                                                                    alignment: _descriptor_4.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_key_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { rem: { cached: false } },
                                         { ins: { cached: true, n: 1 } }]);
    }
    return [];
  }
  _assertLifetime_0(context, partialProofData, valid_until_0, cap_0) {
    __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 2 } },
                                                                                       { idx: { cached: true,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(2n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(valid_until_0),
                                                                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                                                                       'lt',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'expiry must lie in the future');
    if (valid_until_0 > cap_0) {
      let tmp_0;
      __compactRuntime.assert((tmp_0 = (__compactRuntime.assert(valid_until_0
                                                                >=
                                                                cap_0,
                                                                'result of subtraction would be negative'),
                                        valid_until_0 - cap_0),
                               _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                         partialProofData,
                                                                                         [
                                                                                          { push: { storage: false,
                                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(tmp_0),
                                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                                          { dup: { n: 3 } },
                                                                                          { idx: { cached: true,
                                                                                                   pushPath: false,
                                                                                                   path: [
                                                                                                          { tag: 'value',
                                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                                          'lt',
                                                                                          { popeq: { cached: true,
                                                                                                     result: undefined } }]).value)),
                              'expiry too far ahead');
    }
    return [];
  }
  _recordClaim_0(context, partialProofData, key_0, valid_until_0) {
    if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                  partialProofData,
                                                                  [
                                                                   { dup: { n: 0 } },
                                                                   { idx: { cached: false,
                                                                            pushPath: false,
                                                                            path: [
                                                                                   { tag: 'value',
                                                                                     value: { value: _descriptor_4.toValue(7n),
                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                   { push: { storage: false,
                                                                             value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                          alignment: _descriptor_0.alignment() }).encode() } },
                                                                   'member',
                                                                   { popeq: { cached: true,
                                                                              result: undefined } }]).value))
    {
      let t_0;
      __compactRuntime.assert((t_0 = _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                               partialProofData,
                                                                                               [
                                                                                                { dup: { n: 0 } },
                                                                                                { idx: { cached: false,
                                                                                                         pushPath: false,
                                                                                                         path: [
                                                                                                                { tag: 'value',
                                                                                                                  value: { value: _descriptor_4.toValue(7n),
                                                                                                                           alignment: _descriptor_4.alignment() } }] } },
                                                                                                { idx: { cached: false,
                                                                                                         pushPath: false,
                                                                                                         path: [
                                                                                                                { tag: 'value',
                                                                                                                  value: { value: _descriptor_0.toValue(key_0),
                                                                                                                           alignment: _descriptor_0.alignment() } }] } },
                                                                                                { popeq: { cached: false,
                                                                                                           result: undefined } }]).value),
                               t_0 <= valid_until_0),
                              'claim expiry cannot be shortened');
    }
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(7n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(valid_until_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  _attest_0(context, partialProofData, payload_hash_0, metadata_hash_0) {
    const key_0 = this._ownRecord_0(context, partialProofData, payload_hash_0);
    __compactRuntime.assert(!_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                       partialProofData,
                                                                                       [
                                                                                        { dup: { n: 0 } },
                                                                                        { idx: { cached: false,
                                                                                                 pushPath: false,
                                                                                                 path: [
                                                                                                        { tag: 'value',
                                                                                                          value: { value: _descriptor_4.toValue(0n),
                                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                                        { push: { storage: false,
                                                                                                  value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                               alignment: _descriptor_0.alignment() }).encode() } },
                                                                                        'member',
                                                                                        { popeq: { cached: true,
                                                                                                   result: undefined } }]).value),
                            'already attested');
    const tmp_0 = { payload_hash: payload_hash_0,
                    metadata_hash: metadata_hash_0,
                    owner: this._caller_id_0(context, partialProofData),
                    document_id:
                      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(0n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_6.toValue(tmp_0),
                                                                                              alignment: _descriptor_6.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  _retract_0(context, partialProofData, mode_0, key_0) {
    const m_0 = mode_0;
    __compactRuntime.assert(m_0 <= 1n, 'mode out of range');
    if (this._equal_15(m_0, 0n)) {
      const record_0 = this._ownAttestedRecord_0(context,
                                                 partialProofData,
                                                 key_0);
      this._clearRecord_0(context, partialProofData, record_0);
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_4.toValue(0n),
                                                                    alignment: _descriptor_4.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { rem: { cached: false } },
                                         { ins: { cached: true, n: 1 } }]);
      return [];
    } else {
      __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                        partialProofData,
                                                                                        [
                                                                                         { dup: { n: 0 } },
                                                                                         { idx: { cached: false,
                                                                                                  pushPath: false,
                                                                                                  path: [
                                                                                                         { tag: 'value',
                                                                                                           value: { value: _descriptor_4.toValue(7n),
                                                                                                                    alignment: _descriptor_4.alignment() } }] } },
                                                                                         { push: { storage: false,
                                                                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                                                                         'member',
                                                                                         { popeq: { cached: true,
                                                                                                    result: undefined } }]).value),
                              'no claim');
      let tmp_0;
      __compactRuntime.assert((tmp_0 = _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                 partialProofData,
                                                                                                 [
                                                                                                  { dup: { n: 0 } },
                                                                                                  { idx: { cached: false,
                                                                                                           pushPath: false,
                                                                                                           path: [
                                                                                                                  { tag: 'value',
                                                                                                                    value: { value: _descriptor_4.toValue(7n),
                                                                                                                             alignment: _descriptor_4.alignment() } }] } },
                                                                                                  { idx: { cached: false,
                                                                                                           pushPath: false,
                                                                                                           path: [
                                                                                                                  { tag: 'value',
                                                                                                                    value: { value: _descriptor_0.toValue(key_0),
                                                                                                                             alignment: _descriptor_0.alignment() } }] } },
                                                                                                  { popeq: { cached: false,
                                                                                                             result: undefined } }]).value),
                               _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                         partialProofData,
                                                                                         [
                                                                                          { push: { storage: false,
                                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(tmp_0),
                                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                                          { dup: { n: 3 } },
                                                                                          { idx: { cached: true,
                                                                                                   pushPath: false,
                                                                                                   path: [
                                                                                                          { tag: 'value',
                                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                                          'lt',
                                                                                          { popeq: { cached: true,
                                                                                                     result: undefined } }]).value)),
                              'claim not expired');
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_4.toValue(7n),
                                                                    alignment: _descriptor_4.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { rem: { cached: false } },
                                         { ins: { cached: true, n: 1 } }]);
      return [];
    }
  }
  _grantDisclosure_0(context,
                     partialProofData,
                     payload_hash_0,
                     grantee_0,
                     level_0)
  {
    const key_0 = this._ownAttestedRecord_0(context,
                                            partialProofData,
                                            payload_hash_0);
    __compactRuntime.assert(level_0 <= 2n, 'level out of range');
    if (!_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                   partialProofData,
                                                                   [
                                                                    { dup: { n: 0 } },
                                                                    { idx: { cached: false,
                                                                             pushPath: false,
                                                                             path: [
                                                                                    { tag: 'value',
                                                                                      value: { value: _descriptor_4.toValue(2n),
                                                                                               alignment: _descriptor_4.alignment() } }] } },
                                                                    { push: { storage: false,
                                                                              value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                           alignment: _descriptor_0.alignment() }).encode() } },
                                                                    'member',
                                                                    { popeq: { cached: true,
                                                                               result: undefined } }]).value))
    {
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_4.toValue(2n),
                                                                    alignment: _descriptor_4.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { push: { storage: true,
                                                   value: __compactRuntime.StateValue.newMap(
                                                            new __compactRuntime.StateMap()
                                                          ).encode() } },
                                         { ins: { cached: false, n: 1 } },
                                         { ins: { cached: true, n: 1 } }]);
    }
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(2n),
                                                                  alignment: _descriptor_4.alignment() } },
                                                       { tag: 'value',
                                                         value: { value: _descriptor_0.toValue(key_0),
                                                                  alignment: _descriptor_0.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(grantee_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(level_0),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 2 } }]);
    return [];
  }
  _revokeDisclosure_0(context, partialProofData, payload_hash_0, grantee_0) {
    const key_0 = this._ownAttestedRecord_0(context,
                                            partialProofData,
                                            payload_hash_0);
    __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(2n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'no disclosures');
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(2n),
                                                                  alignment: _descriptor_4.alignment() } },
                                                       { tag: 'value',
                                                         value: { value: _descriptor_0.toValue(key_0),
                                                                  alignment: _descriptor_0.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(grantee_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 2 } }]);
    return [];
  }
  _releaseForeignBinding_0(context, partialProofData, document_id_0, owner_id_0)
  {
    if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                  partialProofData,
                                                                  [
                                                                   { dup: { n: 0 } },
                                                                   { idx: { cached: false,
                                                                            pushPath: false,
                                                                            path: [
                                                                                   { tag: 'value',
                                                                                     value: { value: _descriptor_4.toValue(3n),
                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                   { push: { storage: false,
                                                                             value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                                          alignment: _descriptor_0.alignment() }).encode() } },
                                                                   'member',
                                                                   { popeq: { cached: true,
                                                                              result: undefined } }]).value))
    {
      const previous_0 = _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                   partialProofData,
                                                                                   [
                                                                                    { dup: { n: 0 } },
                                                                                    { idx: { cached: false,
                                                                                             pushPath: false,
                                                                                             path: [
                                                                                                    { tag: 'value',
                                                                                                      value: { value: _descriptor_4.toValue(3n),
                                                                                                               alignment: _descriptor_4.alignment() } }] } },
                                                                                    { idx: { cached: false,
                                                                                             pushPath: false,
                                                                                             path: [
                                                                                                    { tag: 'value',
                                                                                                      value: { value: _descriptor_0.toValue(document_id_0),
                                                                                                               alignment: _descriptor_0.alignment() } }] } },
                                                                                    { popeq: { cached: false,
                                                                                               result: undefined } }]).value);
      const old_0 = _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                              partialProofData,
                                                                              [
                                                                               { dup: { n: 0 } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_4.toValue(0n),
                                                                                                          alignment: _descriptor_4.alignment() } }] } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_0.toValue(previous_0),
                                                                                                          alignment: _descriptor_0.alignment() } }] } },
                                                                               { popeq: { cached: false,
                                                                                          result: undefined } }]).value);
      if (!this._equal_16(old_0.owner, owner_id_0)) {
        const tmp_0 = { payload_hash: old_0.payload_hash,
                        metadata_hash: old_0.metadata_hash,
                        owner: old_0.owner,
                        document_id:
                          new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { idx: { cached: false,
                                                    pushPath: true,
                                                    path: [
                                                           { tag: 'value',
                                                             value: { value: _descriptor_4.toValue(0n),
                                                                      alignment: _descriptor_4.alignment() } }] } },
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(previous_0),
                                                                                                  alignment: _descriptor_0.alignment() }).encode() } },
                                           { push: { storage: true,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_6.toValue(tmp_0),
                                                                                                  alignment: _descriptor_6.alignment() }).encode() } },
                                           { ins: { cached: false, n: 1 } },
                                           { ins: { cached: true, n: 1 } }]);
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { idx: { cached: false,
                                                    pushPath: true,
                                                    path: [
                                                           { tag: 'value',
                                                             value: { value: _descriptor_4.toValue(3n),
                                                                      alignment: _descriptor_4.alignment() } }] } },
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                  alignment: _descriptor_0.alignment() }).encode() } },
                                           { rem: { cached: false } },
                                           { ins: { cached: true, n: 1 } }]);
      }
    }
    return [];
  }
  _registerDocument_0(context,
                      partialProofData,
                      mode_0,
                      document_id_0,
                      owner_id_0)
  {
    const m_0 = mode_0;
    __compactRuntime.assert(m_0 <= 4n, 'mode out of range');
    const zero_0 = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    if (m_0 >= 3n) {
      __compactRuntime.assert(this._equal_17(this._caller_id_0(context,
                                                               partialProofData),
                                             _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                       partialProofData,
                                                                                                       [
                                                                                                        { dup: { n: 0 } },
                                                                                                        { idx: { cached: false,
                                                                                                                 pushPath: false,
                                                                                                                 path: [
                                                                                                                        { tag: 'value',
                                                                                                                          value: { value: _descriptor_4.toValue(6n),
                                                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                                                        { popeq: { cached: false,
                                                                                                                   result: undefined } }]).value)),
                              'not recovery');
      __compactRuntime.assert(this._equal_18(document_id_0, zero_0),
                              'id must be the neutral dummy in recovery mode');
      __compactRuntime.assert(!this._equal_19(owner_id_0, zero_0),
                              'identity must not be zero');
      if (this._equal_20(m_0, 3n)) {
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(4n),
                                                                                                  alignment: _descriptor_4.alignment() }).encode() } },
                                           { push: { storage: true,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(owner_id_0),
                                                                                                  alignment: _descriptor_0.alignment() }).encode() } },
                                           { ins: { cached: false, n: 1 } }]);
      } else {
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(6n),
                                                                                                  alignment: _descriptor_4.alignment() }).encode() } },
                                           { push: { storage: true,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(owner_id_0),
                                                                                                  alignment: _descriptor_0.alignment() }).encode() } },
                                           { ins: { cached: false, n: 1 } }]);
      }
      return [];
    } else {
      __compactRuntime.assert(this._equal_21(this._caller_id_0(context,
                                                               partialProofData),
                                             _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                       partialProofData,
                                                                                                       [
                                                                                                        { dup: { n: 0 } },
                                                                                                        { idx: { cached: false,
                                                                                                                 pushPath: false,
                                                                                                                 path: [
                                                                                                                        { tag: 'value',
                                                                                                                          value: { value: _descriptor_4.toValue(4n),
                                                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                                                        { popeq: { cached: false,
                                                                                                                   result: undefined } }]).value)),
                              'not registrar');
      if (this._equal_22(m_0, 0n)) {
        this._releaseForeignBinding_0(context,
                                      partialProofData,
                                      document_id_0,
                                      owner_id_0);
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { idx: { cached: false,
                                                    pushPath: true,
                                                    path: [
                                                           { tag: 'value',
                                                             value: { value: _descriptor_4.toValue(5n),
                                                                      alignment: _descriptor_4.alignment() } }] } },
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                  alignment: _descriptor_0.alignment() }).encode() } },
                                           { push: { storage: true,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(owner_id_0),
                                                                                                  alignment: _descriptor_0.alignment() }).encode() } },
                                           { ins: { cached: false, n: 1 } },
                                           { ins: { cached: true, n: 1 } }]);
        return [];
      } else {
        if (this._equal_23(m_0, 1n)) {
          __compactRuntime.assert(this._equal_24(owner_id_0, zero_0),
                                  'owner must be the neutral dummy in unregister mode');
          __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                            partialProofData,
                                                                                            [
                                                                                             { dup: { n: 0 } },
                                                                                             { idx: { cached: false,
                                                                                                      pushPath: false,
                                                                                                      path: [
                                                                                                             { tag: 'value',
                                                                                                               value: { value: _descriptor_4.toValue(5n),
                                                                                                                        alignment: _descriptor_4.alignment() } }] } },
                                                                                             { push: { storage: false,
                                                                                                       value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                                                                    alignment: _descriptor_0.alignment() }).encode() } },
                                                                                             'member',
                                                                                             { popeq: { cached: true,
                                                                                                        result: undefined } }]).value),
                                  'id not registered');
          __compactRuntime.queryLedgerState(context,
                                            partialProofData,
                                            [
                                             { idx: { cached: false,
                                                      pushPath: true,
                                                      path: [
                                                             { tag: 'value',
                                                               value: { value: _descriptor_4.toValue(5n),
                                                                        alignment: _descriptor_4.alignment() } }] } },
                                             { push: { storage: false,
                                                       value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                    alignment: _descriptor_0.alignment() }).encode() } },
                                             { rem: { cached: false } },
                                             { ins: { cached: true, n: 1 } }]);
          return [];
        } else {
          __compactRuntime.assert(this._equal_25(document_id_0, zero_0),
                                  'id must be the neutral dummy in transfer mode');
          __compactRuntime.assert(!this._equal_26(owner_id_0, zero_0),
                                  'registrar must not be zero');
          __compactRuntime.queryLedgerState(context,
                                            partialProofData,
                                            [
                                             { push: { storage: false,
                                                       value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(4n),
                                                                                                    alignment: _descriptor_4.alignment() }).encode() } },
                                             { push: { storage: true,
                                                       value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(owner_id_0),
                                                                                                    alignment: _descriptor_0.alignment() }).encode() } },
                                             { ins: { cached: false, n: 1 } }]);
          return [];
        }
      }
    }
  }
  _bindDocument_0(context, partialProofData, document_id_0, payload_hash_0) {
    const key_0 = this._ownAttestedRecord_0(context,
                                            partialProofData,
                                            payload_hash_0);
    __compactRuntime.assert(!this._equal_27(document_id_0,
                                            new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
                            'document id must not be zero');
    if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                  partialProofData,
                                                                  [
                                                                   { dup: { n: 0 } },
                                                                   { idx: { cached: false,
                                                                            pushPath: false,
                                                                            path: [
                                                                                   { tag: 'value',
                                                                                     value: { value: _descriptor_4.toValue(5n),
                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                   { push: { storage: false,
                                                                             value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                                          alignment: _descriptor_0.alignment() }).encode() } },
                                                                   'member',
                                                                   { popeq: { cached: true,
                                                                              result: undefined } }]).value))
    {
      __compactRuntime.assert(this._equal_28(_descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                       partialProofData,
                                                                                                       [
                                                                                                        { dup: { n: 0 } },
                                                                                                        { idx: { cached: false,
                                                                                                                 pushPath: false,
                                                                                                                 path: [
                                                                                                                        { tag: 'value',
                                                                                                                          value: { value: _descriptor_4.toValue(5n),
                                                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                                                        { idx: { cached: false,
                                                                                                                 pushPath: false,
                                                                                                                 path: [
                                                                                                                        { tag: 'value',
                                                                                                                          value: { value: _descriptor_0.toValue(document_id_0),
                                                                                                                                   alignment: _descriptor_0.alignment() } }] } },
                                                                                                        { popeq: { cached: false,
                                                                                                                   result: undefined } }]).value),
                                             this._caller_id_0(context,
                                                               partialProofData)),
                              'not document owner');
    } else {
      if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                    partialProofData,
                                                                    [
                                                                     { dup: { n: 0 } },
                                                                     { idx: { cached: false,
                                                                              pushPath: false,
                                                                              path: [
                                                                                     { tag: 'value',
                                                                                       value: { value: _descriptor_4.toValue(3n),
                                                                                                alignment: _descriptor_4.alignment() } }] } },
                                                                     { push: { storage: false,
                                                                               value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                                            alignment: _descriptor_0.alignment() }).encode() } },
                                                                     'member',
                                                                     { popeq: { cached: true,
                                                                                result: undefined } }]).value))
      {
        let tmp_0;
        __compactRuntime.assert(this._equal_29((tmp_0 = _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                  partialProofData,
                                                                                                                  [
                                                                                                                   { dup: { n: 0 } },
                                                                                                                   { idx: { cached: false,
                                                                                                                            pushPath: false,
                                                                                                                            path: [
                                                                                                                                   { tag: 'value',
                                                                                                                                     value: { value: _descriptor_4.toValue(3n),
                                                                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                                                                   { idx: { cached: false,
                                                                                                                            pushPath: false,
                                                                                                                            path: [
                                                                                                                                   { tag: 'value',
                                                                                                                                     value: { value: _descriptor_0.toValue(document_id_0),
                                                                                                                                              alignment: _descriptor_0.alignment() } }] } },
                                                                                                                   { popeq: { cached: false,
                                                                                                                              result: undefined } }]).value),
                                                _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                          partialProofData,
                                                                                                          [
                                                                                                           { dup: { n: 0 } },
                                                                                                           { idx: { cached: false,
                                                                                                                    pushPath: false,
                                                                                                                    path: [
                                                                                                                           { tag: 'value',
                                                                                                                             value: { value: _descriptor_4.toValue(0n),
                                                                                                                                      alignment: _descriptor_4.alignment() } }] } },
                                                                                                           { idx: { cached: false,
                                                                                                                    pushPath: false,
                                                                                                                    path: [
                                                                                                                           { tag: 'value',
                                                                                                                             value: { value: _descriptor_0.toValue(tmp_0),
                                                                                                                                      alignment: _descriptor_0.alignment() } }] } },
                                                                                                           { popeq: { cached: false,
                                                                                                                      result: undefined } }]).value)).owner,
                                               this._caller_id_0(context,
                                                                 partialProofData)),
                                'document bound by another attester');
      }
    }
    if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                  partialProofData,
                                                                  [
                                                                   { dup: { n: 0 } },
                                                                   { idx: { cached: false,
                                                                            pushPath: false,
                                                                            path: [
                                                                                   { tag: 'value',
                                                                                     value: { value: _descriptor_4.toValue(3n),
                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                   { push: { storage: false,
                                                                             value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                                                          alignment: _descriptor_0.alignment() }).encode() } },
                                                                   'member',
                                                                   { popeq: { cached: true,
                                                                              result: undefined } }]).value))
    {
      const previous_0 = _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                   partialProofData,
                                                                                   [
                                                                                    { dup: { n: 0 } },
                                                                                    { idx: { cached: false,
                                                                                             pushPath: false,
                                                                                             path: [
                                                                                                    { tag: 'value',
                                                                                                      value: { value: _descriptor_4.toValue(3n),
                                                                                                               alignment: _descriptor_4.alignment() } }] } },
                                                                                    { idx: { cached: false,
                                                                                             pushPath: false,
                                                                                             path: [
                                                                                                    { tag: 'value',
                                                                                                      value: { value: _descriptor_0.toValue(document_id_0),
                                                                                                               alignment: _descriptor_0.alignment() } }] } },
                                                                                    { popeq: { cached: false,
                                                                                               result: undefined } }]).value);
      if (!this._equal_30(previous_0, key_0)) {
        const old_0 = _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                partialProofData,
                                                                                [
                                                                                 { dup: { n: 0 } },
                                                                                 { idx: { cached: false,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_4.toValue(0n),
                                                                                                            alignment: _descriptor_4.alignment() } }] } },
                                                                                 { idx: { cached: false,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_0.toValue(previous_0),
                                                                                                            alignment: _descriptor_0.alignment() } }] } },
                                                                                 { popeq: { cached: false,
                                                                                            result: undefined } }]).value);
        const tmp_1 = { payload_hash: old_0.payload_hash,
                        metadata_hash: old_0.metadata_hash,
                        owner: old_0.owner,
                        document_id:
                          new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { idx: { cached: false,
                                                    pushPath: true,
                                                    path: [
                                                           { tag: 'value',
                                                             value: { value: _descriptor_4.toValue(0n),
                                                                      alignment: _descriptor_4.alignment() } }] } },
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(previous_0),
                                                                                                  alignment: _descriptor_0.alignment() }).encode() } },
                                           { push: { storage: true,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_6.toValue(tmp_1),
                                                                                                  alignment: _descriptor_6.alignment() }).encode() } },
                                           { ins: { cached: false, n: 1 } },
                                           { ins: { cached: true, n: 1 } }]);
      }
    }
    this._unbindDocument_0(context, partialProofData, key_0);
    const rec_0 = _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                            partialProofData,
                                                                            [
                                                                             { dup: { n: 0 } },
                                                                             { idx: { cached: false,
                                                                                      pushPath: false,
                                                                                      path: [
                                                                                             { tag: 'value',
                                                                                               value: { value: _descriptor_4.toValue(0n),
                                                                                                        alignment: _descriptor_4.alignment() } }] } },
                                                                             { idx: { cached: false,
                                                                                      pushPath: false,
                                                                                      path: [
                                                                                             { tag: 'value',
                                                                                               value: { value: _descriptor_0.toValue(key_0),
                                                                                                        alignment: _descriptor_0.alignment() } }] } },
                                                                             { popeq: { cached: false,
                                                                                        result: undefined } }]).value);
    const tmp_2 = { payload_hash: rec_0.payload_hash,
                    metadata_hash: rec_0.metadata_hash,
                    owner: rec_0.owner,
                    document_id: document_id_0 };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(0n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_6.toValue(tmp_2),
                                                                                              alignment: _descriptor_6.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(3n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(document_id_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  _anchorContentRoot_0(context,
                       partialProofData,
                       payload_hash_0,
                       content_root_0,
                       schema_id_0)
  {
    const key_0 = this._ownAttestedRecord_0(context,
                                            partialProofData,
                                            payload_hash_0);
    if (_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                  partialProofData,
                                                                  [
                                                                   { dup: { n: 0 } },
                                                                   { idx: { cached: false,
                                                                            pushPath: false,
                                                                            path: [
                                                                                   { tag: 'value',
                                                                                     value: { value: _descriptor_4.toValue(1n),
                                                                                              alignment: _descriptor_4.alignment() } }] } },
                                                                   { push: { storage: false,
                                                                             value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                          alignment: _descriptor_0.alignment() }).encode() } },
                                                                   'member',
                                                                   { popeq: { cached: true,
                                                                              result: undefined } }]).value))
    {
      const anchor_0 = _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                 partialProofData,
                                                                                 [
                                                                                  { dup: { n: 0 } },
                                                                                  { idx: { cached: false,
                                                                                           pushPath: false,
                                                                                           path: [
                                                                                                  { tag: 'value',
                                                                                                    value: { value: _descriptor_4.toValue(1n),
                                                                                                             alignment: _descriptor_4.alignment() } }] } },
                                                                                  { idx: { cached: false,
                                                                                           pushPath: false,
                                                                                           path: [
                                                                                                  { tag: 'value',
                                                                                                    value: { value: _descriptor_0.toValue(key_0),
                                                                                                             alignment: _descriptor_0.alignment() } }] } },
                                                                                  { popeq: { cached: false,
                                                                                             result: undefined } }]).value);
      __compactRuntime.assert(this._equal_31(anchor_0.root, content_root_0),
                              'content root already anchored');
      __compactRuntime.assert(this._equal_32(anchor_0.schema, schema_id_0),
                              'schema already anchored');
    } else {
      const tmp_0 = { root: content_root_0, schema: schema_id_0 };
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_4.toValue(1n),
                                                                    alignment: _descriptor_4.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { push: { storage: true,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(tmp_0),
                                                                                                alignment: _descriptor_2.alignment() }).encode() } },
                                         { ins: { cached: false, n: 1 } },
                                         { ins: { cached: true, n: 1 } }]);
    }
    return [];
  }
  _fieldRoot_0(context, partialProofData, leaf_0) {
    const sibs_0 = this._merkle_siblings_0(context, partialProofData);
    const dirs_0 = this._merkle_dirs_0(context, partialProofData);
    const n1_0 = this._merkleStep_0(leaf_0, sibs_0[0], dirs_0[0]);
    const n2_0 = this._merkleStep_0(n1_0, sibs_0[1], dirs_0[1]);
    const n3_0 = this._merkleStep_0(n2_0, sibs_0[2], dirs_0[2]);
    return this._merkleStep_0(n3_0, sibs_0[3], dirs_0[3]);
  }
  _proveFieldPredicate_0(context,
                         partialProofData,
                         record_key_0,
                         field_key_0,
                         threshold_0,
                         op_0,
                         valid_until_0)
  {
    const anchor_0 = this._anchorOf_0(context, partialProofData, record_key_0);
    __compactRuntime.assert(op_0 <= 1n, 'op out of range');
    this._assertLifetime_0(context,
                           partialProofData,
                           valid_until_0,
                           this._maxClaimLifetime_0());
    const v_0 = this._field_value_0(context, partialProofData);
    __compactRuntime.assert(this._equal_33(this._fieldRoot_0(context,
                                                             partialProofData,
                                                             this._leafHash_0(field_key_0,
                                                                              v_0,
                                                                              this._field_salt_0(context,
                                                                                                 partialProofData))),
                                           anchor_0.root),
                            'field not in document');
    if (this._equal_34(op_0, 0n)) {
      __compactRuntime.assert(v_0 <= threshold_0, 'predicate false');
    } else {
      __compactRuntime.assert(v_0 >= threshold_0, 'predicate false');
    }
    const claimKey_0 = this._persistentHash_2({ tag: 16n,
                                                record_key: record_key_0,
                                                content_root: anchor_0.root,
                                                schema_id: anchor_0.schema,
                                                field_key: field_key_0,
                                                threshold: threshold_0,
                                                op: op_0 });
    this._recordClaim_0(context, partialProofData, claimKey_0, valid_until_0);
    return [];
  }
  _proveFieldEquality_0(context,
                        partialProofData,
                        record_key_0,
                        field_key_0,
                        expected_digest_0,
                        valid_until_0)
  {
    const anchor_0 = this._anchorOf_0(context, partialProofData, record_key_0);
    this._assertLifetime_0(context,
                           partialProofData,
                           valid_until_0,
                           this._maxClaimLifetime_0());
    __compactRuntime.assert(this._equal_35(this._fieldRoot_0(context,
                                                             partialProofData,
                                                             this._bytesLeafHash_0(field_key_0,
                                                                                   expected_digest_0,
                                                                                   this._field_salt_0(context,
                                                                                                      partialProofData))),
                                           anchor_0.root),
                            'field not in document');
    const claimKey_0 = this._persistentHash_3({ tag: 17n,
                                                record_key: record_key_0,
                                                content_root: anchor_0.root,
                                                schema_id: anchor_0.schema,
                                                field_key: field_key_0,
                                                expected: expected_digest_0 });
    this._recordClaim_0(context, partialProofData, claimKey_0, valid_until_0);
    return [];
  }
  _proveFieldMembership_0(context,
                          partialProofData,
                          record_key_0,
                          field_key_0,
                          set_root_0,
                          valid_until_0)
  {
    const anchor_0 = this._anchorOf_0(context, partialProofData, record_key_0);
    this._assertLifetime_0(context,
                           partialProofData,
                           valid_until_0,
                           this._maxClaimLifetime_0());
    const d_0 = this._field_digest_0(context, partialProofData);
    __compactRuntime.assert(this._equal_36(this._fieldRoot_0(context,
                                                             partialProofData,
                                                             this._bytesLeafHash_0(field_key_0,
                                                                                   d_0,
                                                                                   this._field_salt_0(context,
                                                                                                      partialProofData))),
                                           anchor_0.root),
                            'field not in document');
    const ssibs_0 = this._set_siblings_0(context, partialProofData);
    const sdirs_0 = this._set_dirs_0(context, partialProofData);
    const s0_0 = this._setLeafHash_0(d_0);
    const s1_0 = this._merkleStep_0(s0_0, ssibs_0[0], sdirs_0[0]);
    const s2_0 = this._merkleStep_0(s1_0, ssibs_0[1], sdirs_0[1]);
    const s3_0 = this._merkleStep_0(s2_0, ssibs_0[2], sdirs_0[2]);
    const s4_0 = this._merkleStep_0(s3_0, ssibs_0[3], sdirs_0[3]);
    const s5_0 = this._merkleStep_0(s4_0, ssibs_0[4], sdirs_0[4]);
    const sroot_0 = this._merkleStep_0(s5_0, ssibs_0[5], sdirs_0[5]);
    __compactRuntime.assert(this._equal_37(sroot_0, set_root_0),
                            'value not in set');
    const claimKey_0 = this._persistentHash_4({ tag: 18n,
                                                record_key: record_key_0,
                                                content_root: anchor_0.root,
                                                schema_id: anchor_0.schema,
                                                field_key: field_key_0,
                                                set_root: set_root_0 });
    this._recordClaim_0(context, partialProofData, claimKey_0, valid_until_0);
    return [];
  }
  _proveDocumentComparison_0(context,
                             partialProofData,
                             record_key_a_0,
                             record_key_b_0,
                             mode_0,
                             allowed_mask_0,
                             k_0,
                             valid_until_0)
  {
    const m_0 = mode_0;
    __compactRuntime.assert(m_0 <= 1n, 'mode out of range');
    if (this._equal_38(m_0, 0n)) {
      __compactRuntime.assert(this._equal_39(k_0, 1n),
                              'k must be the neutral dummy in integrity mode');
    } else {
      __compactRuntime.assert(!(allowed_mask_0[0] || allowed_mask_0[1]
                                ||
                                allowed_mask_0[2]
                                ||
                                allowed_mask_0[3]
                                ||
                                allowed_mask_0[4]
                                ||
                                allowed_mask_0[5]
                                ||
                                allowed_mask_0[6]
                                ||
                                allowed_mask_0[7]
                                ||
                                allowed_mask_0[8]
                                ||
                                allowed_mask_0[9]
                                ||
                                allowed_mask_0[10]
                                ||
                                allowed_mask_0[11]
                                ||
                                allowed_mask_0[12]
                                ||
                                allowed_mask_0[13]
                                ||
                                allowed_mask_0[14]
                                ||
                                allowed_mask_0[15]),
                              'mask must be the neutral dummy in diff mode');
    }
    __compactRuntime.assert(!this._equal_40(record_key_a_0, record_key_b_0),
                            'records must differ');
    __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(1n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_key_a_0),
                                                                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'no content root A');
    __compactRuntime.assert(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(1n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(record_key_b_0),
                                                                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'no content root B');
    this._assertLifetime_0(context,
                           partialProofData,
                           valid_until_0,
                           this._maxClaimLifetime_0());
    const anchorA_0 = _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                partialProofData,
                                                                                [
                                                                                 { dup: { n: 0 } },
                                                                                 { idx: { cached: false,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_4.toValue(1n),
                                                                                                            alignment: _descriptor_4.alignment() } }] } },
                                                                                 { idx: { cached: false,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_0.toValue(record_key_a_0),
                                                                                                            alignment: _descriptor_0.alignment() } }] } },
                                                                                 { popeq: { cached: false,
                                                                                            result: undefined } }]).value);
    const anchorB_0 = _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                partialProofData,
                                                                                [
                                                                                 { dup: { n: 0 } },
                                                                                 { idx: { cached: false,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_4.toValue(1n),
                                                                                                            alignment: _descriptor_4.alignment() } }] } },
                                                                                 { idx: { cached: false,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_0.toValue(record_key_b_0),
                                                                                                            alignment: _descriptor_0.alignment() } }] } },
                                                                                 { popeq: { cached: false,
                                                                                            result: undefined } }]).value);
    const ds_0 = this._doc_schema_0(context, partialProofData);
    const oa_0 = this._doc_slots_a_0(context, partialProofData);
    const ob_0 = this._doc_slots_b_0(context, partialProofData);
    this._assertCanonicalSlot_0(ds_0[0], oa_0[0], ob_0[0]);
    this._assertCanonicalSlot_0(ds_0[1], oa_0[1], ob_0[1]);
    this._assertCanonicalSlot_0(ds_0[2], oa_0[2], ob_0[2]);
    this._assertCanonicalSlot_0(ds_0[3], oa_0[3], ob_0[3]);
    this._assertCanonicalSlot_0(ds_0[4], oa_0[4], ob_0[4]);
    this._assertCanonicalSlot_0(ds_0[5], oa_0[5], ob_0[5]);
    this._assertCanonicalSlot_0(ds_0[6], oa_0[6], ob_0[6]);
    this._assertCanonicalSlot_0(ds_0[7], oa_0[7], ob_0[7]);
    this._assertCanonicalSlot_0(ds_0[8], oa_0[8], ob_0[8]);
    this._assertCanonicalSlot_0(ds_0[9], oa_0[9], ob_0[9]);
    this._assertCanonicalSlot_0(ds_0[10], oa_0[10], ob_0[10]);
    this._assertCanonicalSlot_0(ds_0[11], oa_0[11], ob_0[11]);
    this._assertCanonicalSlot_0(ds_0[12], oa_0[12], ob_0[12]);
    this._assertCanonicalSlot_0(ds_0[13], oa_0[13], ob_0[13]);
    this._assertCanonicalSlot_0(ds_0[14], oa_0[14], ob_0[14]);
    this._assertCanonicalSlot_0(ds_0[15], oa_0[15], ob_0[15]);
    const schemaRoot_0 = this._schemaRootOf_0(ds_0);
    __compactRuntime.assert(this._equal_41(schemaRoot_0, anchorA_0.schema),
                            'doc A schema mismatch');
    __compactRuntime.assert(this._equal_42(schemaRoot_0, anchorB_0.schema),
                            'doc B schema mismatch');
    __compactRuntime.assert(this._equal_43(this._contentRootOf_0(ds_0,
                                                                 oa_0,
                                                                 this._doc_salt_a_0(context,
                                                                                    partialProofData)),
                                           anchorA_0.root),
                            'doc A opening does not match anchored root');
    __compactRuntime.assert(this._equal_44(this._contentRootOf_0(ds_0,
                                                                 ob_0,
                                                                 this._doc_salt_b_0(context,
                                                                                    partialProofData)),
                                           anchorB_0.root),
                            'doc B opening does not match anchored root');
    if (this._equal_45(m_0, 0n)) {
      __compactRuntime.assert(this._constrainsSlot_0(allowed_mask_0[0], ds_0[0])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[1], ds_0[1])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[2], ds_0[2])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[3], ds_0[3])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[4], ds_0[4])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[5], ds_0[5])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[6], ds_0[6])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[7], ds_0[7])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[8], ds_0[8])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[9], ds_0[9])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[10],
                                                     ds_0[10])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[11],
                                                     ds_0[11])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[12],
                                                     ds_0[12])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[13],
                                                     ds_0[13])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[14],
                                                     ds_0[14])
                              ||
                              this._constrainsSlot_0(allowed_mask_0[15],
                                                     ds_0[15]),
                              'mask must constrain at least one schema slot');
      this._assertUnchanged_0(allowed_mask_0[0], ds_0[0], oa_0[0], ob_0[0]);
      this._assertUnchanged_0(allowed_mask_0[1], ds_0[1], oa_0[1], ob_0[1]);
      this._assertUnchanged_0(allowed_mask_0[2], ds_0[2], oa_0[2], ob_0[2]);
      this._assertUnchanged_0(allowed_mask_0[3], ds_0[3], oa_0[3], ob_0[3]);
      this._assertUnchanged_0(allowed_mask_0[4], ds_0[4], oa_0[4], ob_0[4]);
      this._assertUnchanged_0(allowed_mask_0[5], ds_0[5], oa_0[5], ob_0[5]);
      this._assertUnchanged_0(allowed_mask_0[6], ds_0[6], oa_0[6], ob_0[6]);
      this._assertUnchanged_0(allowed_mask_0[7], ds_0[7], oa_0[7], ob_0[7]);
      this._assertUnchanged_0(allowed_mask_0[8], ds_0[8], oa_0[8], ob_0[8]);
      this._assertUnchanged_0(allowed_mask_0[9], ds_0[9], oa_0[9], ob_0[9]);
      this._assertUnchanged_0(allowed_mask_0[10], ds_0[10], oa_0[10], ob_0[10]);
      this._assertUnchanged_0(allowed_mask_0[11], ds_0[11], oa_0[11], ob_0[11]);
      this._assertUnchanged_0(allowed_mask_0[12], ds_0[12], oa_0[12], ob_0[12]);
      this._assertUnchanged_0(allowed_mask_0[13], ds_0[13], oa_0[13], ob_0[13]);
      this._assertUnchanged_0(allowed_mask_0[14], ds_0[14], oa_0[14], ob_0[14]);
      this._assertUnchanged_0(allowed_mask_0[15], ds_0[15], oa_0[15], ob_0[15]);
      const integrityKey_0 = this._persistentHash_6({ tag: 19n,
                                                      record_key_a:
                                                        record_key_a_0,
                                                      content_root_a:
                                                        anchorA_0.root,
                                                      record_key_b:
                                                        record_key_b_0,
                                                      content_root_b:
                                                        anchorB_0.root,
                                                      schema_id: schemaRoot_0,
                                                      allowed_mask:
                                                        allowed_mask_0 });
      this._recordClaim_0(context,
                          partialProofData,
                          integrityKey_0,
                          valid_until_0);
      return [];
    } else {
      __compactRuntime.assert(k_0 >= 1n && k_0 <= 16n, 'k out of range');
      const count_0 = this._slotDiff_0(ds_0[0], oa_0[0], ob_0[0])
                      +
                      this._slotDiff_0(ds_0[1], oa_0[1], ob_0[1])
                      +
                      this._slotDiff_0(ds_0[2], oa_0[2], ob_0[2])
                      +
                      this._slotDiff_0(ds_0[3], oa_0[3], ob_0[3])
                      +
                      this._slotDiff_0(ds_0[4], oa_0[4], ob_0[4])
                      +
                      this._slotDiff_0(ds_0[5], oa_0[5], ob_0[5])
                      +
                      this._slotDiff_0(ds_0[6], oa_0[6], ob_0[6])
                      +
                      this._slotDiff_0(ds_0[7], oa_0[7], ob_0[7])
                      +
                      this._slotDiff_0(ds_0[8], oa_0[8], ob_0[8])
                      +
                      this._slotDiff_0(ds_0[9], oa_0[9], ob_0[9])
                      +
                      this._slotDiff_0(ds_0[10], oa_0[10], ob_0[10])
                      +
                      this._slotDiff_0(ds_0[11], oa_0[11], ob_0[11])
                      +
                      this._slotDiff_0(ds_0[12], oa_0[12], ob_0[12])
                      +
                      this._slotDiff_0(ds_0[13], oa_0[13], ob_0[13])
                      +
                      this._slotDiff_0(ds_0[14], oa_0[14], ob_0[14])
                      +
                      this._slotDiff_0(ds_0[15], oa_0[15], ob_0[15]);
      __compactRuntime.assert(count_0 >= k_0, 'too few differing fields');
      const diffKey_0 = this._persistentHash_5({ tag: 20n,
                                                 record_key_a: record_key_a_0,
                                                 content_root_a: anchorA_0.root,
                                                 record_key_b: record_key_b_0,
                                                 content_root_b: anchorB_0.root,
                                                 schema_id: schemaRoot_0,
                                                 k: k_0 });
      this._recordClaim_0(context, partialProofData, diffKey_0, valid_until_0);
      return [];
    }
  }
  _equal_0(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_1(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_2(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_3(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_4(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_5(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_6(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_7(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_8(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_9(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_10(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_11(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_12(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_13(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_14(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_15(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_16(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_17(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_18(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_19(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_20(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_21(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_22(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_23(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_24(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_25(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_26(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_27(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_28(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_29(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_30(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_31(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_32(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_33(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_34(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_35(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_36(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_37(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_38(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_39(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
  _equal_40(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_41(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_42(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_43(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_44(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_45(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
}
export function ledger(stateOrChargedState) {
  const state = stateOrChargedState instanceof __compactRuntime.StateValue ? stateOrChargedState : stateOrChargedState.state;
  const chargedState = stateOrChargedState instanceof __compactRuntime.StateValue ? new __compactRuntime.ChargedState(stateOrChargedState) : stateOrChargedState;
  const context = {
    currentQueryContext: new __compactRuntime.QueryContext(chargedState, __compactRuntime.dummyContractAddress()),
    costModel: __compactRuntime.CostModel.initialCostModel()
  };
  const partialProofData = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: []
  };
  return {
    attestations: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(0n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(0n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'attestation-vault.compact line 46 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(0n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'attestation-vault.compact line 46 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(0n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_0.toValue(key_0),
                                                                                                     alignment: _descriptor_0.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[0];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_0.fromValue(key.value),      _descriptor_6.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    content_anchors: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(1n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(1n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'attestation-vault.compact line 47 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(1n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'attestation-vault.compact line 47 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(1n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_0.toValue(key_0),
                                                                                                     alignment: _descriptor_0.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[1];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_0.fromValue(key.value),      _descriptor_2.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    disclosures: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'attestation-vault.compact line 48 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'attestation-vault.compact line 48 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        if (state.asArray()[2].asMap().get({ value: _descriptor_0.toValue(key_0),
                                             alignment: _descriptor_0.alignment() }) === undefined) {
          throw new __compactRuntime.CompactError(`Map value undefined for ${key_0}`);
        }
        return {
          isEmpty(...args_1) {
            if (args_1.length !== 0) {
              throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_1.length}`);
            }
            return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                             partialProofData,
                                                                             [
                                                                              { dup: { n: 0 } },
                                                                              { idx: { cached: false,
                                                                                       pushPath: false,
                                                                                       path: [
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_4.toValue(2n),
                                                                                                         alignment: _descriptor_4.alignment() } },
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_0.toValue(key_0),
                                                                                                         alignment: _descriptor_0.alignment() } }] } },
                                                                              'size',
                                                                              { push: { storage: false,
                                                                                        value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                                                                     alignment: _descriptor_1.alignment() }).encode() } },
                                                                              'eq',
                                                                              { popeq: { cached: true,
                                                                                         result: undefined } }]).value);
          },
          size(...args_1) {
            if (args_1.length !== 0) {
              throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_1.length}`);
            }
            return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                             partialProofData,
                                                                             [
                                                                              { dup: { n: 0 } },
                                                                              { idx: { cached: false,
                                                                                       pushPath: false,
                                                                                       path: [
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_4.toValue(2n),
                                                                                                         alignment: _descriptor_4.alignment() } },
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_0.toValue(key_0),
                                                                                                         alignment: _descriptor_0.alignment() } }] } },
                                                                              'size',
                                                                              { popeq: { cached: true,
                                                                                         result: undefined } }]).value);
          },
          member(...args_1) {
            if (args_1.length !== 1) {
              throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_1.length}`);
            }
            const key_1 = args_1[0];
            if (!(key_1.buffer instanceof ArrayBuffer && key_1.BYTES_PER_ELEMENT === 1 && key_1.length === 32)) {
              __compactRuntime.typeError('member',
                                         'argument 1',
                                         'attestation-vault.compact line 48 char 49',
                                         'Bytes<32>',
                                         key_1)
            }
            return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                             partialProofData,
                                                                             [
                                                                              { dup: { n: 0 } },
                                                                              { idx: { cached: false,
                                                                                       pushPath: false,
                                                                                       path: [
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_4.toValue(2n),
                                                                                                         alignment: _descriptor_4.alignment() } },
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_0.toValue(key_0),
                                                                                                         alignment: _descriptor_0.alignment() } }] } },
                                                                              { push: { storage: false,
                                                                                        value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_1),
                                                                                                                                     alignment: _descriptor_0.alignment() }).encode() } },
                                                                              'member',
                                                                              { popeq: { cached: true,
                                                                                         result: undefined } }]).value);
          },
          lookup(...args_1) {
            if (args_1.length !== 1) {
              throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_1.length}`);
            }
            const key_1 = args_1[0];
            if (!(key_1.buffer instanceof ArrayBuffer && key_1.BYTES_PER_ELEMENT === 1 && key_1.length === 32)) {
              __compactRuntime.typeError('lookup',
                                         'argument 1',
                                         'attestation-vault.compact line 48 char 49',
                                         'Bytes<32>',
                                         key_1)
            }
            return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                             partialProofData,
                                                                             [
                                                                              { dup: { n: 0 } },
                                                                              { idx: { cached: false,
                                                                                       pushPath: false,
                                                                                       path: [
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_4.toValue(2n),
                                                                                                         alignment: _descriptor_4.alignment() } },
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_0.toValue(key_0),
                                                                                                         alignment: _descriptor_0.alignment() } }] } },
                                                                              { idx: { cached: false,
                                                                                       pushPath: false,
                                                                                       path: [
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_0.toValue(key_1),
                                                                                                         alignment: _descriptor_0.alignment() } }] } },
                                                                              { popeq: { cached: false,
                                                                                         result: undefined } }]).value);
          },
          [Symbol.iterator](...args_1) {
            if (args_1.length !== 0) {
              throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_1.length}`);
            }
            const self_0 = state.asArray()[2].asMap().get({ value: _descriptor_0.toValue(key_0),
                                                            alignment: _descriptor_0.alignment() });
            return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_0.fromValue(key.value),      _descriptor_4.fromValue(value.value)    ];  })[Symbol.iterator]();
          }
        }
      }
    },
    document_bindings: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(3n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(3n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'attestation-vault.compact line 52 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(3n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'attestation-vault.compact line 52 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(3n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_0.toValue(key_0),
                                                                                                     alignment: _descriptor_0.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[3];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_0.fromValue(key.value),      _descriptor_0.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    get registrar() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_4.toValue(4n),
                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    document_owners: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(5n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(5n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'attestation-vault.compact line 58 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(5n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'attestation-vault.compact line 58 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(5n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_0.toValue(key_0),
                                                                                                     alignment: _descriptor_0.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[5];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_0.fromValue(key.value),      _descriptor_0.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    get recovery() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_4.toValue(6n),
                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    claims: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(7n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(7n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'attestation-vault.compact line 69 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(7n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'attestation-vault.compact line 69 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(7n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_0.toValue(key_0),
                                                                                                     alignment: _descriptor_0.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[7];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_0.fromValue(key.value),      _descriptor_1.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    }
  };
}
const _emptyContext = {
  currentQueryContext: new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, __compactRuntime.dummyContractAddress())
};
const _dummyContract = new Contract({
  local_secret_key: (...args) => undefined,
  field_value: (...args) => undefined,
  field_salt: (...args) => undefined,
  merkle_siblings: (...args) => undefined,
  merkle_dirs: (...args) => undefined,
  field_digest: (...args) => undefined,
  set_siblings: (...args) => undefined,
  set_dirs: (...args) => undefined,
  doc_schema: (...args) => undefined,
  doc_salt_a: (...args) => undefined,
  doc_salt_b: (...args) => undefined,
  doc_slots_a: (...args) => undefined,
  doc_slots_b: (...args) => undefined
});
export const pureCircuits = {
  leafHash: (...args_0) => {
    if (args_0.length !== 3) {
      throw new __compactRuntime.CompactError(`leafHash: expected 3 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const field_key_0 = args_0[0];
    const value_0 = args_0[1];
    const salt_0 = args_0[2];
    if (!(field_key_0.buffer instanceof ArrayBuffer && field_key_0.BYTES_PER_ELEMENT === 1 && field_key_0.length === 32)) {
      __compactRuntime.typeError('leafHash',
                                 'argument 1',
                                 'attestation-vault.compact line 269 char 1',
                                 'Bytes<32>',
                                 field_key_0)
    }
    if (!(typeof(value_0) === 'bigint' && value_0 >= 0n && value_0 <= 18446744073709551615n)) {
      __compactRuntime.typeError('leafHash',
                                 'argument 2',
                                 'attestation-vault.compact line 269 char 1',
                                 'Uint<0..18446744073709551616>',
                                 value_0)
    }
    if (!(salt_0.buffer instanceof ArrayBuffer && salt_0.BYTES_PER_ELEMENT === 1 && salt_0.length === 32)) {
      __compactRuntime.typeError('leafHash',
                                 'argument 3',
                                 'attestation-vault.compact line 269 char 1',
                                 'Bytes<32>',
                                 salt_0)
    }
    return _dummyContract._leafHash_0(field_key_0, value_0, salt_0);
  },
  bytesLeafHash: (...args_0) => {
    if (args_0.length !== 3) {
      throw new __compactRuntime.CompactError(`bytesLeafHash: expected 3 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const field_key_0 = args_0[0];
    const value_digest_0 = args_0[1];
    const salt_0 = args_0[2];
    if (!(field_key_0.buffer instanceof ArrayBuffer && field_key_0.BYTES_PER_ELEMENT === 1 && field_key_0.length === 32)) {
      __compactRuntime.typeError('bytesLeafHash',
                                 'argument 1',
                                 'attestation-vault.compact line 273 char 1',
                                 'Bytes<32>',
                                 field_key_0)
    }
    if (!(value_digest_0.buffer instanceof ArrayBuffer && value_digest_0.BYTES_PER_ELEMENT === 1 && value_digest_0.length === 32)) {
      __compactRuntime.typeError('bytesLeafHash',
                                 'argument 2',
                                 'attestation-vault.compact line 273 char 1',
                                 'Bytes<32>',
                                 value_digest_0)
    }
    if (!(salt_0.buffer instanceof ArrayBuffer && salt_0.BYTES_PER_ELEMENT === 1 && salt_0.length === 32)) {
      __compactRuntime.typeError('bytesLeafHash',
                                 'argument 3',
                                 'attestation-vault.compact line 273 char 1',
                                 'Bytes<32>',
                                 salt_0)
    }
    return _dummyContract._bytesLeafHash_0(field_key_0, value_digest_0, salt_0);
  },
  absentLeafHash: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(`absentLeafHash: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const field_key_0 = args_0[0];
    const salt_0 = args_0[1];
    if (!(field_key_0.buffer instanceof ArrayBuffer && field_key_0.BYTES_PER_ELEMENT === 1 && field_key_0.length === 32)) {
      __compactRuntime.typeError('absentLeafHash',
                                 'argument 1',
                                 'attestation-vault.compact line 277 char 1',
                                 'Bytes<32>',
                                 field_key_0)
    }
    if (!(salt_0.buffer instanceof ArrayBuffer && salt_0.BYTES_PER_ELEMENT === 1 && salt_0.length === 32)) {
      __compactRuntime.typeError('absentLeafHash',
                                 'argument 2',
                                 'attestation-vault.compact line 277 char 1',
                                 'Bytes<32>',
                                 salt_0)
    }
    return _dummyContract._absentLeafHash_0(field_key_0, salt_0);
  },
  nodeHash: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(`nodeHash: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const left_0 = args_0[0];
    const right_0 = args_0[1];
    if (!(left_0.buffer instanceof ArrayBuffer && left_0.BYTES_PER_ELEMENT === 1 && left_0.length === 32)) {
      __compactRuntime.typeError('nodeHash',
                                 'argument 1',
                                 'attestation-vault.compact line 281 char 1',
                                 'Bytes<32>',
                                 left_0)
    }
    if (!(right_0.buffer instanceof ArrayBuffer && right_0.BYTES_PER_ELEMENT === 1 && right_0.length === 32)) {
      __compactRuntime.typeError('nodeHash',
                                 'argument 2',
                                 'attestation-vault.compact line 281 char 1',
                                 'Bytes<32>',
                                 right_0)
    }
    return _dummyContract._nodeHash_0(left_0, right_0);
  },
  setLeafHash: (...args_0) => {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`setLeafHash: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const value_digest_0 = args_0[0];
    if (!(value_digest_0.buffer instanceof ArrayBuffer && value_digest_0.BYTES_PER_ELEMENT === 1 && value_digest_0.length === 32)) {
      __compactRuntime.typeError('setLeafHash',
                                 'argument 1',
                                 'attestation-vault.compact line 287 char 1',
                                 'Bytes<32>',
                                 value_digest_0)
    }
    return _dummyContract._setLeafHash_0(value_digest_0);
  },
  descriptorLeafHash: (...args_0) => {
    if (args_0.length !== 3) {
      throw new __compactRuntime.CompactError(`descriptorLeafHash: expected 3 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const field_key_0 = args_0[0];
    const kind_0 = args_0[1];
    const scale_0 = args_0[2];
    if (!(field_key_0.buffer instanceof ArrayBuffer && field_key_0.BYTES_PER_ELEMENT === 1 && field_key_0.length === 32)) {
      __compactRuntime.typeError('descriptorLeafHash',
                                 'argument 1',
                                 'attestation-vault.compact line 291 char 1',
                                 'Bytes<32>',
                                 field_key_0)
    }
    if (!(typeof(kind_0) === 'bigint' && kind_0 >= 0n && kind_0 <= 255n)) {
      __compactRuntime.typeError('descriptorLeafHash',
                                 'argument 2',
                                 'attestation-vault.compact line 291 char 1',
                                 'Uint<0..256>',
                                 kind_0)
    }
    if (!(typeof(scale_0) === 'bigint' && scale_0 >= 0n && scale_0 <= 18446744073709551615n)) {
      __compactRuntime.typeError('descriptorLeafHash',
                                 'argument 3',
                                 'attestation-vault.compact line 291 char 1',
                                 'Uint<0..18446744073709551616>',
                                 scale_0)
    }
    return _dummyContract._descriptorLeafHash_0(field_key_0, kind_0, scale_0);
  },
  slotSalt: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(`slotSalt: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const seed_0 = args_0[0];
    const index_0 = args_0[1];
    if (!(seed_0.buffer instanceof ArrayBuffer && seed_0.BYTES_PER_ELEMENT === 1 && seed_0.length === 32)) {
      __compactRuntime.typeError('slotSalt',
                                 'argument 1',
                                 'attestation-vault.compact line 295 char 1',
                                 'Bytes<32>',
                                 seed_0)
    }
    if (!(typeof(index_0) === 'bigint' && index_0 >= 0n && index_0 <= 255n)) {
      __compactRuntime.typeError('slotSalt',
                                 'argument 2',
                                 'attestation-vault.compact line 295 char 1',
                                 'Uint<0..256>',
                                 index_0)
    }
    return _dummyContract._slotSalt_0(seed_0, index_0);
  },
  emptyLeafKey: (...args_0) => {
    if (args_0.length !== 0) {
      throw new __compactRuntime.CompactError(`emptyLeafKey: expected 0 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    return _dummyContract._emptyLeafKey_0();
  },
  recordKey: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(`recordKey: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const owner_0 = args_0[0];
    const payload_hash_0 = args_0[1];
    if (!(owner_0.buffer instanceof ArrayBuffer && owner_0.BYTES_PER_ELEMENT === 1 && owner_0.length === 32)) {
      __compactRuntime.typeError('recordKey',
                                 'argument 1',
                                 'attestation-vault.compact line 310 char 1',
                                 'Bytes<32>',
                                 owner_0)
    }
    if (!(payload_hash_0.buffer instanceof ArrayBuffer && payload_hash_0.BYTES_PER_ELEMENT === 1 && payload_hash_0.length === 32)) {
      __compactRuntime.typeError('recordKey',
                                 'argument 2',
                                 'attestation-vault.compact line 310 char 1',
                                 'Bytes<32>',
                                 payload_hash_0)
    }
    return _dummyContract._recordKey_0(owner_0, payload_hash_0);
  }
};
export const contractReferenceLocations =
  { tag: 'publicLedgerArray', indices: { } };
//# sourceMappingURL=index.js.map
