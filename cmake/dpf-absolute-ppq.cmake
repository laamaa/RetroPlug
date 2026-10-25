set(_DPF_PATCH_DIR "${DPFJS_PATH}/deps/dpf")
# Keep patches independent so already-patched checkouts can pick up new fixes.
foreach(_DPF_PATCH_NAME IN ITEMS dpf-absolute-ppq dpf-latency-notify dpf-macos-buffer-default)
    set(_DPF_PATCH "${CMAKE_SOURCE_DIR}/cmake/patches/${_DPF_PATCH_NAME}.patch")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_DPF_PATCH}")
    execute_process(COMMAND git apply --reverse --check "${_DPF_PATCH}"
        WORKING_DIRECTORY "${_DPF_PATCH_DIR}" RESULT_VARIABLE _DPF_PATCH_PRESENT
        OUTPUT_QUIET ERROR_QUIET)
    if(NOT _DPF_PATCH_PRESENT EQUAL 0)
        execute_process(COMMAND git apply "${_DPF_PATCH}"
            WORKING_DIRECTORY "${_DPF_PATCH_DIR}" RESULT_VARIABLE _DPF_PATCH_RESULT)
        if(NOT _DPF_PATCH_RESULT EQUAL 0)
            message(FATAL_ERROR "Could not apply DPF patch ${_DPF_PATCH}")
        endif()
    endif()
endforeach()
