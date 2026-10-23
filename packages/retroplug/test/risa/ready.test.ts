import {test,expect} from "../../testing/harness";
import {risaReadyStatus} from "../../src/risa/romDetect";
test("ready addresses come from the ROM and reject incomplete or out-of-RAM metadata",()=>{
 const header=new Uint8Array(0x150);
 header.set(new TextEncoder().encode("RREADY1"),32);
 header.set([0x84,3,0x89,3],39);
 expect(risaReadyStatus(header)).toEqual({prepareAddress:900,generationAddress:905});
 expect(risaReadyStatus(header.slice(0,42))).toBe(undefined);
 header[40]=8;
 expect(risaReadyStatus(header)).toBe(undefined);
});
